import express, { Express, Request, Response } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import swaggerJsdoc from 'swagger-jsdoc';
import swaggerUi from 'swagger-ui-express';
import cookieParser from 'cookie-parser';
import rateLimit from 'express-rate-limit';
import { database } from './config/database';
import { swaggerConfig } from './config/swagger';
import { authenticateToken } from './middlewares/auth.middleware';
import QRCode from 'qrcode';
import { randomBytes } from 'crypto';
import multer from 'multer';
import Tesseract from 'tesseract.js';
import Redis from 'ioredis';

import marcasRoutes from './routes/marcas.routes';
import lineasRoutes from './routes/lineas.routes';
import ofertasRoutes from './routes/ofertas.routes';
import authRoutes from './routes/auth.routes';
import productsRoutes from './routes/products.routes';
import homeRoutes from './routes/home.routes';
import ordersRoutes from './routes/orders.routes';
import rolesRoutes from './routes/roles.routes';
import chatRoutes from './routes/chat.routes';
import cierreCajaRoutes from './routes/cierre-caja.routes';

const app: Express = express();
const PORT = process.env.PORT || 3000;

// Trust proxy for proper IP detection behind Nginx reverse proxy
app.set('trust proxy', 1);
app.use(express.json({ limit: '50mb' })); 
app.use(express.urlencoded({ limit: '50mb', extended: true }));

const swaggerSpec = swaggerJsdoc(swaggerConfig);

const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';
let redis: Redis | null = null;

try {
  redis = new Redis(redisUrl, {
    lazyConnect: true,
    maxRetriesPerRequest: 3,
    retryStrategy: (times) => {
      if (times > 3) return null;
      return Math.min(times * 200, 2000);
    }
  });
  
  redis.on('error', (err) => {
    console.log('Redis connection error (non-blocking):', err.message);
  });
  
  redis.on('connect', () => {
    console.log('Connected to Redis');
  });
} catch (error) {
  console.log('Redis initialization failed, continuing without cache');
}

const CACHE_TTL = 300;

const cacheGet = async (key: string): Promise<string | null> => {
  if (!redis) return null;
  try {
    return await redis.get(key);
  } catch (e) {
    return null;
  }
};

const cacheSet = async (key: string, value: string, ttl: number = CACHE_TTL): Promise<void> => {
  if (!redis) return;
  try {
    await redis.setex(key, ttl, value);
  } catch (e) {
    console.log('Cache set error:', e);
  }
};

const cacheDelete = async (key: string): Promise<void> => {
  if (!redis) return;
  try {
    await redis.del(key);
  } catch (e) {}
};

const cacheDeletePattern = async (pattern: string): Promise<void> => {
  if (!redis) return;
  try {
    const keys = await redis.keys(pattern);
    if (keys.length > 0) {
      await redis.del(...keys);
    }
  } catch (e) {}
};

const withCache = (ttl: number = CACHE_TTL) => {
  return async (req: Request, res: Response, next: () => void) => {
    if (req.method !== 'GET') return next();
    
    const path = req.path;
    if (path.includes('/users') || path.includes('/profile')) return next();
    
    const cacheKey = `req:${req.originalUrl}`;
    const cached = await cacheGet(cacheKey);
    if (cached) {
      res.header('X-Cache', 'HIT');
      res.json(JSON.parse(cached));
      return;
    }
    
    const originalJson = res.json.bind(res);
    res.json = (body: any) => {
      cacheSet(cacheKey, JSON.stringify(body), ttl).catch(() => {});
      res.header('X-Cache', 'MISS');
      return originalJson(body);
    };
    
    next();
  };
};

const invalidateCache = (req: Request, res: Response, next: () => void) => {
  if (['POST', 'PUT', 'DELETE', 'PATCH'].includes(req.method)) {
    const path = req.path;
    
    if (path.includes('/products')) {
      cacheDeletePattern('req:/api/products*');
    } else if (path.includes('/marcas')) {
      cacheDeletePattern('req:/api/marcas*');
    } else if (path.includes('/lineas')) {
      cacheDeletePattern('req:/api/lineas*');
    } else if (path.includes('/ofertas')) {
      cacheDeletePattern('req:/api/ofertas*');
    } else if (path.includes('/home')) {
      cacheDeletePattern('req:/api/home*');
    } else if (path.includes('/roles')) {
      cacheDeletePattern('req:/api/roles*');
    }
  }
  next();
};

const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 100,
  message: { error: 'Demasiadas solicitudes, intente más tarde' },
  standardHeaders: true,
  legacyHeaders: false,
});

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  skipSuccessfulRequests: true,
  message: { error: 'Demasiados intentos de login, intente en 15 minutos' },
  standardHeaders: true,
  legacyHeaders: false,
});

const ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS 
  ? process.env.ALLOWED_ORIGINS.split(',')
  : ['http://localhost:4200', 'http://localhost:3000', 'https://escolares.vercel.app', 'https://escolares-ng.vercel.app'];

const corsOptions = {
  origin: function (origin: string | undefined, callback: (err: Error | null, allow?: boolean) => void) {
    if (!origin || ALLOWED_ORIGINS.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'), false);
    }
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'x-dolarvzla-key'],
};

app.use(cors(corsOptions));
app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false,
}));
app.use(generalLimiter);
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));
app.use(cookieParser());

const DOLAR_API_KEY = '29b324b9a34615a7e8f1d945ea95bb22e621cfe3ae2d6b36e957bb08d1fa7fa7'
const DOLAR_API_URL = 'https://api.dolarvzla.com/public/bcv/exchange-rate';
const USDT_API_URL = 'https://api.dolarvzla.com/public/usdt/exchange-rate';

const qrUploadTokens = new Map<string, { proveedorId: string; facturaIndex: number; timestamp: number }>();

app.get('/api/tasas', async (req: Request, res: Response) => {
  const cacheKey = 'tasas:current';
  const cached = await cacheGet(cacheKey);
  if (cached) {
    res.header('X-Cache', 'HIT');
    res.json(JSON.parse(cached));
    return;
  }

  try {
    const apiKeySettings = await database.getCollection('settings').findOne({ key: 'dolarApiKey' });
    const apiKey = apiKeySettings?.value || DOLAR_API_KEY;

    const [bcvRes, usdtRes] = await Promise.all([
      fetch(DOLAR_API_URL, {
        headers: {
          'x-dolarvzla-key': apiKey,
        },
      }),
      fetch(USDT_API_URL, {
        headers: {
          'x-dolarvzla-key': apiKey,
        },
      }),
    ]);

    if (bcvRes.status === 401) {
      await cacheSet(cacheKey, JSON.stringify({ apiKeyExpired: true }), 60);
      res.header('X-Cache', 'MISS');
      res.json({ apiKeyExpired: true, error: 'API key inválida o caducada' });
      return;
    }
    
    if (!bcvRes.ok) {
      res.status(500).json({ error: 'Error al obtener tasas' });
      return;
    }

    const bcvData: any = await bcvRes.json();
    const usdtData: any = usdtRes.ok ? await usdtRes.json() : null;

    const result: any = {};

    if (bcvData?.current) {
      result.current = {
        usd: bcvData.current.usd,
        eur: bcvData.current.eur,
      };
    }

    if (usdtData?.current) {
      result.current = result.current || {};
      const binanceValue =
        usdtData.current.usdt ||
        usdtData.current.binance ||
        usdtData.current.usd ||
        usdtData.current.price ||
        usdtData.current.USDT ||
        usdtData.current.average;
      result.current.binance = binanceValue;
    }

    await cacheSet(cacheKey, JSON.stringify(result), 60);
    res.header('X-Cache', 'MISS');
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET');
    res.header('Access-Control-Allow-Headers', 'Content-Type');
    res.json(result);
  } catch (error) {
    console.error('Error fetching tasas:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/settings/tasas-status', async (req: Request, res: Response) => {
  try {
    const cacheKey = 'tasas:current';
    const cached = await cacheGet(cacheKey);
    
    if (cached) {
      const cachedData = JSON.parse(cached);
      if (cachedData.apiKeyExpired) {
        res.json({ apiKeyExpired: true });
        return;
      }
    }
    
    const apiKeySettings = await database.getCollection('settings').findOne({ key: 'dolarApiKey' });
    const apiKey = apiKeySettings?.value || DOLAR_API_KEY;
    
    const bcvRes = await fetch(DOLAR_API_URL, {
      headers: { 'x-dolarvzla-key': apiKey },
    });
    
    if (bcvRes.status === 401) {
      res.json({ apiKeyExpired: true });
    } else {
      res.json({ apiKeyExpired: false });
    }
  } catch (error) {
    res.status(500).json({ error: 'Error al verificar estado de tasas' });
  }
});

app.get('/api/settings/dolar-api-key', authenticateToken, async (req: Request, res: Response) => {
  try {
    const user = req.user as any;
    if (user.rol !== 'root') {
      res.status(403).json({ error: 'Solo el usuario root puede acceder a esta configuración' });
      return;
    }

    const apiKeySettings = await database.getCollection('settings').findOne({ key: 'dolarApiKey' });
    res.json({ hasApiKey: !!apiKeySettings?.value, apiKey: apiKeySettings?.value || '' });
  } catch (error) {
    console.error('Error getting dolar API key:', error);
    res.status(500).json({ error: 'Error al obtener la API key' });
  }
});

app.put('/api/settings/dolar-api-key', authenticateToken, async (req: Request, res: Response) => {
  try {
    const user = req.user as any;
    if (user.rol !== 'root') {
      res.status(403).json({ error: 'Solo el usuario root puede modificar esta configuración' });
      return;
    }

    const { apiKey } = req.body;
    if (!apiKey || typeof apiKey !== 'string') {
      res.status(400).json({ error: 'Se requiere una API key válida' });
      return;
    }

    await database.getCollection('settings').updateOne(
      { key: 'dolarApiKey' },
      { $set: { key: 'dolarApiKey', value: apiKey.trim(), updatedAt: new Date() } },
      { upsert: true }
    );

    res.json({ success: true, message: 'API key guardada correctamente' });
  } catch (error) {
    console.error('Error saving dolar API key:', error);
    res.status(500).json({ error: 'Error al guardar la API key' });
  }
});

// Currency Display Settings - Global for all users
app.get('/api/settings/currency-display', async (req: Request, res: Response) => {
  try {
    const settings = await database.getCollection('settings').findOne({ key: 'currencyDisplay' });
    res.json({ display: settings?.value || 'USD' });
  } catch (error) {
    console.error('Error getting currency display:', error);
    res.status(500).json({ error: 'Error al obtener la configuración de moneda' });
  }
});

app.put('/api/settings/currency-display', authenticateToken, async (req: Request, res: Response) => {
  try {
    const user = req.user as any;
    if (user.rol !== 'root') {
      res.status(403).json({ error: 'Solo el usuario root puede modificar esta configuración' });
      return;
    }

    const { display } = req.body;
    const validDisplays = ['USD', 'BS', 'BOTH'];
    if (!display || !validDisplays.includes(display)) {
      res.status(400).json({ error: 'Se requiere un valor válido: USD, BS o BOTH' });
      return;
    }

    await database.getCollection('settings').updateOne(
      { key: 'currencyDisplay' },
      { $set: { key: 'currencyDisplay', value: display, updatedAt: new Date() } },
      { upsert: true }
    );

    // Invalidate cache for all product-related endpoints
    cacheDeletePattern('req:/api/products*');
    cacheDeletePattern('req:/api/home*');

    res.json({ success: true, display });
  } catch (error) {
    console.error('Error saving currency display:', error);
    res.status(500).json({ error: 'Error al guardar la configuración de moneda' });
  }
});

// Compras Deshabilitadas Settings - Global for all users
app.get('/api/settings/compras-deshabilitadas', async (req: Request, res: Response) => {
  try {
    const settings = await database.getCollection('settings').findOne({ key: 'comprasDeshabilitadas' });
    res.json({ disabled: settings?.value === true });
  } catch (error) {
    console.error('Error getting compras setting:', error);
    res.status(500).json({ error: 'Error al obtener la configuración de compras' });
  }
});

app.put('/api/settings/compras-deshabilitadas', authenticateToken, async (req: Request, res: Response) => {
  try {
    const user = req.user as any;
    if (user.rol !== 'root') {
      res.status(403).json({ error: 'Solo el usuario root puede modificar esta configuración' });
      return;
    }

    const { disabled } = req.body;
    if (typeof disabled !== 'boolean') {
      res.status(400).json({ error: 'Se requiere un valor booleano' });
      return;
    }

    await database.getCollection('settings').updateOne(
      { key: 'comprasDeshabilitadas' },
      { $set: { key: 'comprasDeshabilitadas', value: disabled, updatedAt: new Date() } },
      { upsert: true }
    );

    res.json({ success: true, disabled });
  } catch (error) {
    console.error('Error saving compras setting:', error);
    res.status(500).json({ error: 'Error al guardar la configuración de compras' });
  }
});

app.use(
  '/api-docs',
  swaggerUi.serve,
  swaggerUi.setup(swaggerSpec, {
    customCss: '.swagger-ui .topbar { display: none }',
    customSiteTitle: 'API Escolares - Swagger',
  }),
);

app.get('/swagger.json', (req: Request, res: Response) => {
  res.json(swaggerSpec);
});

app.get('/health', (req: Request, res: Response) => {
  res.json({ status: 'OK', message: 'API Escolares funcionando' });
});

app.post('/api/registros', async (req: Request, res: Response) => {
  try {
    const { accion, modulo, descripcion, usuario, datos } = req.body;

    const registro = {
      accion,
      modulo,
      descripcion,
      usuario: usuario || 'admin',
      datos: datos || {},
      fecha: new Date(),
    };

    const collection = database.getCollection('registros');
    const result = await collection.insertOne(registro);

    res.json({ success: result.insertedId });
  } catch (error) {
    console.error('Error guardando registro:', error);
    res.status(500).json({ error: 'Error al guardar registro' });
  }
});

app.get('/api/registros', async (req: Request, res: Response) => {
  try {
    const { modulo, limit = 100 } = req.query;
    const collection = database.getCollection('registros');

    const filter: any = {};
    if (modulo) {
      filter.modulo = modulo;
    }

    const registros = await collection
      .find(filter)
      .sort({ fecha: -1 })
      .limit(Number(limit))
      .toArray();

    res.json(registros);
  } catch (error) {
    console.error('Error obteniendo registros:', error);
    res.status(500).json({ error: 'Error al obtener registros' });
  }
});

app.delete('/api/registros', async (req: Request, res: Response) => {
  try {
    const collection = database.getCollection('registros');
    await collection.deleteMany({});
    res.json({ success: true });
  } catch (error) {
    console.error('Error eliminando registros:', error);
    res.status(500).json({ error: 'Error al eliminar registros' });
  }
});

app.post('/api/costos', async (req: Request, res: Response) => {
  try {
    const { nombre, numero, tipo, data } = req.body;

    const grupo = {
      nombre,
      numero,
      tipo,
      fecha: new Date(),
      data: data || [],
    };

    const collection = database.getCollection('costos');
    const result = await collection.insertOne(grupo);

    res.json({ success: true, id: result.insertedId });
  } catch (error) {
    console.error('Error guardando grupo:', error);
    res.status(500).json({ error: 'Error al guardar grupo' });
  }
});

app.get('/api/costos', async (req: Request, res: Response) => {
  try {
    const collection = database.getCollection('costos');
    const grupos = await collection.find().sort({ fecha: -1 }).toArray();
    res.json(grupos);
  } catch (error) {
    console.error('Error obteniendo grupos:', error);
    res.status(500).json({ error: 'Error al obtener grupos' });
  }
});

app.post('/api/costos/:id/costo', async (req: Request, res: Response) => {
  try {
    const { ObjectId } = await import('mongodb');
    const collection = database.getCollection('costos');
    const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;

    const costoData = req.body;
    costoData.fecha = new Date();

    await collection.updateOne({ _id: new ObjectId(id) }, { $push: { data: costoData } });

    res.json({ success: true });
  } catch (error) {
    console.error('Error agregando costo al grupo:', error);
    res.status(500).json({ error: 'Error al agregar costo al grupo' });
  }
});

app.put('/api/costos/:id/costo', async (req: Request, res: Response) => {
  try {
    const { ObjectId } = await import('mongodb');
    const collection = database.getCollection('costos');
    const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;

    await collection.updateOne({ _id: new ObjectId(id) }, { $set: req.body });

    res.json({ success: true });
  } catch (error) {
    console.error('Error actualizando costo:', error);
    res.status(500).json({ error: 'Error al actualizar costo' });
  }
});

app.put('/api/costos/:id/costo/:index', async (req: Request, res: Response) => {
  try {
    const { ObjectId } = await import('mongodb');
    const collection = database.getCollection('costos');
    const idParam = req.params.id;
    const id = Array.isArray(idParam) ? idParam[0] : idParam;
    const indexParam = req.params.index;
    const index = Array.isArray(indexParam) ? parseInt(indexParam[0]) : parseInt(indexParam);

    const grupo = await collection.findOne({ _id: new ObjectId(id) });
    if (!grupo || !grupo.data || index < 0 || index >= grupo.data.length) {
      res.status(404).json({ error: 'Costo no encontrado' });
      return;
    }

    grupo.data[index] = { ...grupo.data[index], ...req.body };
    await collection.updateOne({ _id: new ObjectId(id) }, { $set: { data: grupo.data } });

    res.json({ success: true });
  } catch (error) {
    console.error('Error actualizando costo:', error);
    res.status(500).json({ error: 'Error al actualizar costo' });
  }
});

app.delete('/api/costos/:id/costo/:index', async (req: Request, res: Response) => {
  try {
    const { ObjectId } = await import('mongodb');
    const collection = database.getCollection('costos');
    const idParam = req.params.id;
    const id = Array.isArray(idParam) ? idParam[0] : idParam;
    const indexParam = req.params.index;
    const index = Array.isArray(indexParam) ? parseInt(indexParam[0]) : parseInt(indexParam);

    const grupo = await collection.findOne({ _id: new ObjectId(id) });
    if (!grupo || !grupo.data || index < 0 || index >= grupo.data.length) {
      res.status(404).json({ error: 'Costo no encontrado' });
      return;
    }

    grupo.data.splice(index, 1);
    await collection.updateOne({ _id: new ObjectId(id) }, { $set: { data: grupo.data } });

    res.json({ success: true });
  } catch (error) {
    console.error('Error eliminando costo:', error);
    res.status(500).json({ error: 'Error al eliminar costo' });
  }
});

app.delete('/api/costos/:id', async (req: Request, res: Response) => {
  try {
    const { ObjectId } = await import('mongodb');
    const collection = database.getCollection('costos');
    const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    await collection.deleteOne({ _id: new ObjectId(id) });
    res.json({ success: true });
  } catch (error) {
    console.error('Error eliminando grupo:', error);
    res.status(500).json({ error: 'Error al eliminar grupo' });
  }
});

app.post('/api/facturas', async (req: Request, res: Response) => {
  try {
    const { cliente, productos, total, estado } = req.body;

    const factura = {
      cliente,
      productos: productos || [],
      total: total || 0,
      estado: estado || 'pendiente',
      fecha: new Date(),
      fechaPago: estado === 'pagado' ? new Date() : null,
    };

    const collection = database.getCollection('facturas');
    const result = await collection.insertOne(factura);

    res.json({ success: true, id: result.insertedId });
  } catch (error) {
    console.error('Error guardando factura:', error);
    res.status(500).json({ error: 'Error al guardar factura' });
  }
});

app.get('/api/facturas', async (req: Request, res: Response) => {
  try {
    const collection = database.getCollection('facturas');
    const facturas = await collection.find().sort({ fecha: -1 }).toArray();
    res.json(facturas);
  } catch (error) {
    console.error('Error obteniendo facturas:', error);
    res.status(500).json({ error: 'Error al obtener facturas' });
  }
});

app.get('/api/facturas/resumen', async (req: Request, res: Response) => {
  try {
    const collection = database.getCollection('facturas');
    const facturas = await collection.find().toArray();

    const pendientes = facturas.filter(f => f.estado === 'pendiente');
    const pagadas = facturas.filter(f => f.estado === 'pagado');

    const dineroEntrante = pendientes.reduce((sum, f) => sum + (f.total || 0), 0);
    const dineroReal = pagadas.reduce((sum, f) => sum + (f.total || 0), 0);
    const brecha = dineroEntrante;

    const porMes: Record<string, { entrante: number; real: number }> = {};
    
    facturas.forEach(f => {
      const mes = new Date(f.fecha).toLocaleString('es-VE', { year: 'numeric', month: 'short' });
      if (!porMes[mes]) {
        porMes[mes] = { entrante: 0, real: 0 };
      }
      if (f.estado === 'pendiente') {
        porMes[mes].entrante += f.total || 0;
      } else if (f.estado === 'pagado') {
        porMes[mes].real += f.total || 0;
      }
    });

    res.json({
      dineroEntrante,
      dineroReal,
      brecha,
      totalFacturas: facturas.length,
      pendientes: pendientes.length,
      pagadas: pagadas.length,
      porMes: Object.entries(porMes).map(([mes, datos]) => ({ mes, ...datos }))
    });
  } catch (error) {
    console.error('Error obteniendo resumen:', error);
    res.status(500).json({ error: 'Error al obtener resumen' });
  }
});

app.put('/api/facturas/:id', async (req: Request, res: Response) => {
  try {
    const { ObjectId } = await import('mongodb');
    const { estado } = req.body;
    const idParam = req.params.id;
    const id = Array.isArray(idParam) ? idParam[0] : idParam;
    
    const updateData: any = { estado };
    if (estado === 'pagado') {
      updateData.fechaPago = new Date();
    }

    const collection = database.getCollection('facturas');
    await collection.updateOne(
      { _id: new ObjectId(id) },
      { $set: updateData }
    );

    res.json({ success: true });
  } catch (error) {
    console.error('Error actualizando factura:', error);
    res.status(500).json({ error: 'Error al actualizar factura' });
  }
});

app.delete('/api/facturas/:id', async (req: Request, res: Response) => {
  try {
    const { ObjectId } = await import('mongodb');
    const collection = database.getCollection('facturas');
    const idParam = req.params.id;
    const id = Array.isArray(idParam) ? idParam[0] : idParam;
    await collection.deleteOne({ _id: new ObjectId(id) });
    res.json({ success: true });
  } catch (error) {
    console.error('Error eliminando factura:', error);
    res.status(500).json({ error: 'Error al eliminar factura' });
  }
});


app.get('/api/proveedores', async (req: Request, res: Response) => {
  try {
    const db = (database as any).db;
    if (!db) {
      res.status(500).json({ error: 'Base de datos no conectada' });
      return;
    }
    const collectionNames = await db.listCollections().toArray();
    const hasCollection = collectionNames.some((c: any) => c.name === 'proveedores');
    if (!hasCollection) {
      await db.createCollection('proveedores');
    }
    const collection = (database as any).getCollection('proveedores');
    let proveedores = await collection.find().sort({ nombre: 1 }).toArray();
    
    for (const proveedor of proveedores) {
      if (proveedor.cuentasBancarias && proveedor.cuentasBancarias.length > 0) {
        const bancosUnicos = new Set<string>();
        for (const cuenta of proveedor.cuentasBancarias) {
          if (cuenta.bancosAfiliados && cuenta.bancosAfiliados.length > 0) {
            cuenta.bancosAfiliados.forEach((b: string) => bancosUnicos.add(b));
          }
        }
        if (bancosUnicos.size > 0) {
          const bancosAfiliadosArray = Array.from(bancosUnicos);
          if (!proveedor.bancosAfiliados || proveedor.bancosAfiliados.length === 0) {
            await collection.updateOne(
              { _id: proveedor._id },
              { $set: { bancosAfiliados: bancosAfiliadosArray } }
            );
            proveedor.bancosAfiliados = bancosAfiliadosArray;
          }
        }
      }
    }
    
    res.json(proveedores);
  } catch (error: any) {
    console.error('Error obteniendo proveedores:', error);
    res.status(500).json({ error: 'Error al obtener proveedores', details: error.message });
  }
});

app.post('/api/proveedores', authenticateToken, async (req: Request, res: Response) => {
  try {
    const { nombre, alias, rif, direccion, correo, telefono, vendedor, tasaPreferida, cuentasBancarias } = req.body;
    const usuario = (req as any).user?.nombre || (req as any).user?.username || (req as any).user?.email || 'Sistema';
    
    if (!nombre) {
      res.status(400).json({ error: 'El nombre es requerido' });
      return;
    }
    
    const db = (database as any).db;
    if (!db) {
      res.status(500).json({ error: 'Base de datos no conectada' });
      return;
    }
    
    const collectionNames = await db.listCollections().toArray();
    const hasCollection = collectionNames.some((c: any) => c.name === 'proveedores');
    if (!hasCollection) {
      await db.createCollection('proveedores');
    }
    
    const proveedor = {
      nombre,
      alias: alias || '',
      rif: rif || '',
      direccion: direccion || '',
      correo: correo || '',
      telefono: telefono || '',
      vendedor: vendedor || '',
      tasaPreferida: tasaPreferida || 'dolar',
      cuentasBancarias: cuentasBancarias || [],
      facturas: [],
      creadoPor: usuario,
      fechaCreacion: new Date(),
    };
    
    const collection = (database as any).getCollection('proveedores');
    const result = await collection.insertOne(proveedor);
    
    let registrosCollection = (database as any).getCollection('registros');
    if (!registrosCollection) {
      await (database as any).db.createCollection('registros');
      registrosCollection = (database as any).getCollection('registros');
    }
    await registrosCollection.insertOne({
      accion: 'Creación',
      modulo: 'Proveedores',
      descripcion: `Proveedor creado: ${nombre}`,
      datos: { proveedor: proveedor },
      usuario: usuario,
      fecha: new Date(),
    });
    
    res.json({ success: true, id: result.insertedId });
  } catch (error: any) {
    console.error('Error creando proveedor:', error);
    res.status(500).json({ error: 'Error al crear proveedor', details: error.message });
  }
});

app.put('/api/proveedores/:id', authenticateToken, async (req: Request, res: Response) => {
  try {
    const { ObjectId } = await import('mongodb');
    const { nombre, alias, rif, direccion, correo, telefono, vendedor, tasaPreferida, cuentasBancarias } = req.body;
    const usuario = (req as any).user?.nombre || (req as any).user?.username || (req as any).user?.email || 'Sistema';
    const idParam = req.params.id;
    const id = Array.isArray(idParam) ? idParam[0] : idParam;
    const collection = (database as any).getCollection('proveedores');
    
    const proveedorActual = await collection.findOne({ _id: new ObjectId(id) });
    
    const modificaciones: { campo: string; valorAnterior: string; valorNuevo: string; fecha: Date; usuario: string }[] = [];
    
    const campos = ['nombre', 'alias', 'rif', 'direccion', 'correo', 'telefono', 'vendedor', 'tasaPreferida', 'cuentasBancarias'];
    campos.forEach(campo => {
      const valorAnterior = JSON.stringify(proveedorActual?.[campo]);
      const valorNuevo = JSON.stringify(req.body[campo]);
      if (valorAnterior !== valorNuevo) {
        modificaciones.push({
          campo,
          valorAnterior: proveedorActual?.[campo] || '',
          valorNuevo: req.body[campo] || '',
          fecha: new Date(),
          usuario: usuario
        });
      }
    });
    
    const updateData: any = { nombre, alias, rif, direccion, correo, telefono, vendedor, tasaPreferida, cuentasBancarias, modificadoPor: usuario, fechaModificacion: new Date() };
    
    const updateOperation: any = { $set: updateData };
    
    if (modificaciones.length > 0) {
      updateOperation.$push = { modificaciones: { $each: modificaciones } };
    }
    
    await collection.updateOne(
      { _id: new ObjectId(id) },
      updateOperation
    );
    
    if (modificaciones.length > 0) {
      let registrosCollection = (database as any).getCollection('registros');
      if (!registrosCollection) {
        await (database as any).db.createCollection('registros');
        registrosCollection = (database as any).getCollection('registros');
      }
      await registrosCollection.insertOne({
        accion: 'Modificación',
        modulo: 'Proveedores',
        descripcion: `Proveedor modificado: ${nombre}`,
        datos: { modificaciones, proveedorId: id },
        usuario: usuario,
        fecha: new Date(),
      });
    }
    
    res.json({ success: true });
  } catch (error) {
    console.error('Error actualizando proveedor:', error);
    res.status(500).json({ error: 'Error al actualizar proveedor' });
  }
});

app.delete('/api/proveedores/:id', authenticateToken, async (req: Request, res: Response) => {
  try {
    const { ObjectId } = await import('mongodb');
    const idParam = req.params.id;
    const id = Array.isArray(idParam) ? idParam[0] : idParam;
    const usuario = (req as any).user?.nombre || (req as any).user?.username || (req as any).user?.email || 'Sistema';
    const collection = (database as any).getCollection('proveedores');
    
    const proveedor = await collection.findOne({ _id: new ObjectId(id) });
    await collection.deleteOne({ _id: new ObjectId(id) });
    
    let registrosCollection = (database as any).getCollection('registros');
    if (!registrosCollection) {
      await (database as any).db.createCollection('registros');
      registrosCollection = (database as any).getCollection('registros');
    }
    await registrosCollection.insertOne({
      accion: 'Eliminación',
      modulo: 'Proveedores',
      descripcion: `Proveedor eliminado: ${proveedor?.nombre || 'Desconocido'}`,
      datos: { proveedorId: id, proveedor: proveedor },
      usuario: usuario,
      fecha: new Date(),
    });
    
    res.json({ success: true });
  } catch (error) {
    console.error('Error eliminando proveedor:', error);
    res.status(500).json({ error: 'Error al eliminar proveedor' });
  }
});

app.post('/api/proveedores/:id/facturas', async (req: Request, res: Response) => {
  try {
    const { ObjectId } = await import('mongodb');
    const { numero, fecha, tipo, monto, montoIva, baseImponible, baseExenta, exentoBsf, porcentajeIva, imagenes, montoBsf, numeroControl } = req.body;
    const idParam = req.params.id;
    const id = Array.isArray(idParam) ? idParam[0] : idParam;
    
    const tipoDoc = tipo || 'factura';
    let baseImpo = baseImponible || 0;
    let baseEx = baseExenta || 0;
    let iva = montoIva !== undefined ? montoIva : 0;
    let iva75 = 0;
    let iva25 = 0;
    let totalPagar = 0;
    let deudaActual = 0;
    let deudaIva = 0;
    let deudaIva25 = 0;
    
    if (tipoDoc === 'nota') {
      baseImpo = 0;
      baseEx = monto || 0;
      iva = 0;
      iva75 = 0;
      iva25 = 0;
      totalPagar = baseEx;
      deudaActual = baseEx;
      deudaIva = 0;
      deudaIva25 = 0;
    } else {
      const ivaPorcentaje = porcentajeIva || 0;
      iva = montoIva !== undefined ? montoIva : (baseImpo * (ivaPorcentaje / 100));
      iva75 = iva * 0.75;
      iva25 = iva * 0.25;
      totalPagar = monto + baseEx;
      deudaActual = monto + baseEx;
      deudaIva = iva75;
      deudaIva25 = iva25;
    }
    
    const factura: any = {
      numero,
      tipo: tipoDoc,
      monto: monto || 0,
      montoIva: montoIva || 0,
      fecha: fecha ? new Date(fecha) : new Date(),
      baseImponible: baseImpo,
      baseExenta: baseEx,
      exentoBsf: exentoBsf || 0,
      porcentajeIva: porcentajeIva || 0,
      iva: iva,
      iva75: iva75,
      iva25: iva25,
      abonos: 0,
      abonosIva: 0,
      abonosIva25: 0,
      totalPagar: totalPagar,
      deudaActual: deudaActual,
      deudaIva: deudaIva,
      deudaIva25: deudaIva25 || 0,
      montoBsf: montoBsf || 0,
    };
    
    if (tipoDoc === 'factura' && numeroControl) {
      factura.numeroControl = numeroControl;
    }
    
    if (imagenes && Array.isArray(imagenes) && imagenes.length > 0) {
      factura.imagenes = imagenes;
    }
    
    const collection = (database as any).getCollection('proveedores');
    
    const proveedor = await collection.findOne({ _id: new ObjectId(id) });
    const nuevoIndex = proveedor?.facturas?.length || 0;
    
    await collection.updateOne(
      { _id: new ObjectId(id) },
      { $push: { facturas: factura } }
    );
    res.json({ success: true, index: nuevoIndex });
  } catch (error) {
    console.error('Error agregando factura:', error);
    res.status(500).json({ error: 'Error al agregar factura' });
  }
});

app.put('/api/proveedores/:id/facturas/:index', async (req: Request, res: Response) => {
  try {
    const { ObjectId } = await import('mongodb');
    const idParam = req.params.id;
    const id = Array.isArray(idParam) ? idParam[0] : idParam;
    const indexParam = req.params.index;
    const index = Array.isArray(indexParam) ? parseInt(indexParam[0]) : parseInt(indexParam);
    
    const { numero, fecha, tipo, monto, montoIva, baseImponible, baseExenta, exentoBsf, abonos, totalPagar, imagenes, montoBsf, numeroControl } = req.body;
    
    const collection = (database as any).getCollection('proveedores');
    const proveedor = await collection.findOne({ _id: new ObjectId(id) });
    
    if (!proveedor || !proveedor.facturas || index < 0 || index >= proveedor.facturas.length) {
      res.status(404).json({ error: 'Factura no encontrada' });
      return;
    }
    
    const factura = proveedor.facturas[index];
    const imagenesActuales = factura.imagenes || [];
    const tipoDoc = tipo || factura.tipo || 'factura';
    let nuevaBaseImponible = baseImponible !== undefined ? baseImponible : factura.baseImponible;
    let nuevaBaseExenta = baseExenta !== undefined ? baseExenta : (factura.baseExenta || 0);
    const nuevosAbonos = abonos !== undefined ? abonos : factura.abonos;
    let deudaActual = 0;
    let nuevoTotalPagar = totalPagar !== undefined ? totalPagar : factura.totalPagar;
    let nuevoIva = factura.iva || 0;
    let nuevoIva75 = factura.iva75 || 0;
    let nuevoIva25 = factura.iva25 || 0;
    let deudaIva = factura.deudaIva || 0;
    let deudaIva25 = factura.deudaIva25 || 0;
    
    if (tipoDoc === 'nota') {
      nuevaBaseImponible = 0;
      nuevaBaseExenta = monto !== undefined ? monto : factura.monto || 0;
      nuevoIva = 0;
      nuevoIva75 = 0;
      nuevoIva25 = 0;
      deudaActual = nuevaBaseExenta - nuevosAbonos;
      nuevoTotalPagar = nuevaBaseExenta;
      deudaIva = 0;
      deudaIva25 = 0;
    } else {
      const montoFact = monto !== undefined ? monto : factura.monto || 0;
      const montoIvaFact = montoIva !== undefined ? montoIva : factura.montoIva || 0;
      const baseExentaFact = nuevaBaseExenta;
      nuevaBaseImponible = montoFact;
      nuevoIva = montoIvaFact;
      nuevoIva75 = montoIvaFact * 0.75;
      nuevoIva25 = montoIvaFact * 0.25;
      deudaActual = montoFact + baseExentaFact - nuevosAbonos;
      nuevoTotalPagar = montoFact + baseExentaFact;
      deudaIva = nuevoIva75;
      deudaIva25 = nuevoIva25;
    }
    
    proveedor.facturas[index] = {
      ...factura,
      numero: numero !== undefined ? numero : factura.numero,
      fecha: fecha ? new Date(fecha) : factura.fecha,
      tipo: tipoDoc,
      monto: monto !== undefined ? monto : factura.monto || 0,
      montoIva: montoIva !== undefined ? montoIva : factura.montoIva || 0,
      baseImponible: nuevaBaseImponible,
      baseExenta: nuevaBaseExenta,
      iva: nuevoIva,
      iva75: nuevoIva75,
      iva25: nuevoIva25,
      abonos: nuevosAbonos,
      totalPagar: nuevoTotalPagar,
      deudaActual,
      deudaIva,
      deudaIva25,
      imagenes: imagenes !== undefined ? imagenes : imagenesActuales,
      montoBsf: montoBsf !== undefined ? montoBsf : (factura.montoBsf || 0),
      exentoBsf: exentoBsf !== undefined ? exentoBsf : (factura.exentoBsf || 0),
      numeroControl: tipoDoc === 'factura' && numeroControl !== undefined ? numeroControl : factura.numeroControl,
    };
    
    await collection.updateOne(
      { _id: new ObjectId(id) },
      { $set: { facturas: proveedor.facturas } }
    );
    res.json({ success: true });
  } catch (error) {
    console.error('Error actualizando factura:', error);
    res.status(500).json({ error: 'Error al actualizar factura' });
  }
});

app.post('/api/proveedores/:id/facturas/:index/abonos', async (req: Request, res: Response) => {
  try {
    const { ObjectId } = await import('mongodb');
    const idParam = req.params.id;
    const id = Array.isArray(idParam) ? idParam[0] : idParam;
    const indexParam = req.params.index;
    const index = Array.isArray(indexParam) ? parseInt(indexParam[0]) : parseInt(indexParam);
    
    const { monto, fechaAbono } = req.body;
    
    console.log('Recibido - monto:', monto, 'tipo:', typeof monto, 'fechaAbono:', fechaAbono);
    
    const montoNum = parseFloat(monto);
    if (isNaN(montoNum) || montoNum <= 0) {
      res.status(400).json({ error: 'Monto de abono inválido', received: monto });
      return;
    }
    
    const collection = (database as any).getCollection('proveedores');
    const proveedor = await collection.findOne({ _id: new ObjectId(id) });
    
    if (!proveedor) {
      res.status(404).json({ error: 'Proveedor no encontrado' });
      return;
    }
    
    if (!proveedor.facturas || index < 0 || index >= proveedor.facturas.length) {
      res.status(404).json({ error: 'Factura no encontrada', index, facturasLength: proveedor.facturas?.length });
      return;
    }
    
    const factura = proveedor.facturas[index];
    const abonoActual = factura.abonos || 0;
    const nuevoAbono = abonoActual + montoNum;
    const montoBase = (factura.monto || 0) + (factura.baseExenta || 0);
    const deudaActual = montoBase - nuevoAbono;
    
    const abonosArray = factura.abonosArray || [];
    abonosArray.push({
      monto: montoNum,
      fecha: fechaAbono ? new Date(fechaAbono + 'T00:00:00') : new Date(),
    });
    
    proveedor.facturas[index] = {
      ...factura,
      abonos: nuevoAbono,
      abonosArray: abonosArray,
      deudaActual: deudaActual < 0 ? 0 : deudaActual,
      pagada: deudaActual <= 0,
    };
    
    await collection.updateOne(
      { _id: new ObjectId(id) },
      { $set: { facturas: proveedor.facturas } }
    );
    res.json({ success: true });
  } catch (error: any) {
    console.error('Error actualizando abono:', error);
    res.status(500).json({ error: 'Error al actualizar abono', details: error.message });
  }
});

app.post('/api/proveedores/:id/facturas/:index/abonos-iva', async (req: Request, res: Response) => {
  try {
    const { ObjectId } = await import('mongodb');
    const idParam = req.params.id;
    const id = Array.isArray(idParam) ? idParam[0] : idParam;
    const indexParam = req.params.index;
    const index = Array.isArray(indexParam) ? parseInt(indexParam[0]) : parseInt(indexParam);
    
    const { monto, fechaAbono } = req.body;
    
    const montoNum = parseFloat(monto);
    if (isNaN(montoNum) || montoNum <= 0) {
      res.status(400).json({ error: 'Monto de abono IVA inválido', received: monto });
      return;
    }
    
    const collection = (database as any).getCollection('proveedores');
    const proveedor = await collection.findOne({ _id: new ObjectId(id) });
    
    if (!proveedor) {
      res.status(404).json({ error: 'Proveedor no encontrado' });
      return;
    }
    
    if (!proveedor.facturas || index < 0 || index >= proveedor.facturas.length) {
      res.status(404).json({ error: 'Factura no encontrada', index, facturasLength: proveedor.facturas?.length });
      return;
    }
    
    const factura = proveedor.facturas[index];
    const abonosIvaArray = factura.abonosIvaArray || [];
    abonosIvaArray.push({
      monto: montoNum,
      fecha: fechaAbono ? new Date(fechaAbono + 'T00:00:00') : new Date(),
    });
    
    const nuevoAbonoIva = (factura.abonosIva || 0) + montoNum;
    const deudaIva = (factura.iva75 || 0) - nuevoAbonoIva;
    
    proveedor.facturas[index] = {
      ...factura,
      abonosIva: nuevoAbonoIva,
      abonosIvaArray: abonosIvaArray,
      deudaIva: deudaIva < 0 ? 0 : deudaIva,
    };
    
    await collection.updateOne(
      { _id: new ObjectId(id) },
      { $set: { facturas: proveedor.facturas } }
    );
    res.json({ success: true });
  } catch (error: any) {
    console.error('Error agregando abono IVA:', error);
    res.status(500).json({ error: 'Error al agregar abono IVA', details: error.message });
  }
});

app.post('/api/proveedores/:id/facturas/:index/abonos-iva25', async (req: Request, res: Response) => {
  try {
    const { ObjectId } = await import('mongodb');
    const idParam = req.params.id;
    const id = Array.isArray(idParam) ? idParam[0] : idParam;
    const indexParam = req.params.index;
    const index = Array.isArray(indexParam) ? parseInt(indexParam[0]) : parseInt(indexParam);
    
    const { monto, fechaAbono } = req.body;
    
    const montoNum = parseFloat(monto);
    if (isNaN(montoNum) || montoNum <= 0) {
      res.status(400).json({ error: 'Monto de abono IVA 25% inválido', received: monto });
      return;
    }
    
    const collection = (database as any).getCollection('proveedores');
    const proveedor = await collection.findOne({ _id: new ObjectId(id) });
    
    if (!proveedor) {
      res.status(404).json({ error: 'Proveedor no encontrado' });
      return;
    }
    
    if (!proveedor.facturas || index < 0 || index >= proveedor.facturas.length) {
      res.status(404).json({ error: 'Factura no encontrada', index, facturasLength: proveedor.facturas?.length });
      return;
    }
    
    const factura = proveedor.facturas[index];
    const abonosIva25Array = factura.abonosIva25Array || [];
    abonosIva25Array.push({
      monto: montoNum,
      fecha: fechaAbono ? new Date(fechaAbono + 'T00:00:00') : new Date(),
    });
    
    const nuevoAbonoIva25 = (factura.abonosIva25 || 0) + montoNum;
    const deudaIva25 = (factura.iva25 || 0) - nuevoAbonoIva25;
    
    proveedor.facturas[index] = {
      ...factura,
      abonosIva25: nuevoAbonoIva25,
      abonosIva25Array: abonosIva25Array,
      deudaIva25: deudaIva25 < 0 ? 0 : deudaIva25,
    };
    
    await collection.updateOne(
      { _id: new ObjectId(id) },
      { $set: { facturas: proveedor.facturas } }
    );
    res.json({ success: true });
  } catch (error: any) {
    console.error('Error agregando abono IVA 25%:', error);
    res.status(500).json({ error: 'Error al agregar abono IVA 25%', details: error.message });
  }
});

app.delete('/api/proveedores/:id/facturas/:index/abonos/:abonoIndex', async (req: Request, res: Response) => {
  try {
    const { ObjectId } = await import('mongodb');
    const idParam = req.params.id;
    const id = Array.isArray(idParam) ? idParam[0] : idParam;
    const indexParam = req.params.index;
    const index = Array.isArray(indexParam) ? parseInt(indexParam[0]) : parseInt(indexParam);
    const abonoIndexParam = req.params.abonoIndex;
    const abonoIndex = Array.isArray(abonoIndexParam) ? parseInt(abonoIndexParam[0]) : parseInt(abonoIndexParam);
    
    const collection = (database as any).getCollection('proveedores');
    const proveedor = await collection.findOne({ _id: new ObjectId(id) });
    
    if (!proveedor) {
      res.status(404).json({ error: 'Proveedor no encontrado' });
      return;
    }
    
    if (!proveedor.facturas || index < 0 || index >= proveedor.facturas.length) {
      res.status(404).json({ error: 'Factura no encontrada' });
      return;
    }
    
    const factura = proveedor.facturas[index];
    const abonosArray = factura.abonosArray || [];
    
    if (abonoIndex < 0 || abonoIndex >= abonosArray.length) {
      res.status(404).json({ error: 'Abono no encontrado' });
      return;
    }
    
    const montoEliminado = abonosArray[abonoIndex].monto;
    abonosArray.splice(abonoIndex, 1);
    
    const nuevoAbono = (factura.abonos || 0) - montoEliminado;
    const montoBase = (factura.monto || 0) + (factura.baseExenta || 0);
    const deudaActual = montoBase - nuevoAbono;
    
    proveedor.facturas[index] = {
      ...factura,
      abonos: nuevoAbono,
      abonosArray: abonosArray,
      deudaActual: deudaActual < 0 ? 0 : deudaActual,
      pagada: deudaActual <= 0,
    };
    
    await collection.updateOne(
      { _id: new ObjectId(id) },
      { $set: { facturas: proveedor.facturas } }
    );
    res.json({ success: true });
  } catch (error: any) {
    console.error('Error eliminando abono:', error);
    res.status(500).json({ error: 'Error al eliminar abono', details: error.message });
  }
});

app.put('/api/proveedores/:id/facturas/:index/abonos-iva/:abonoIndex', async (req: Request, res: Response) => {
  try {
    const { ObjectId } = await import('mongodb');
    const idParam = req.params.id;
    const id = Array.isArray(idParam) ? idParam[0] : idParam;
    const indexParam = req.params.index;
    const index = Array.isArray(indexParam) ? parseInt(indexParam[0]) : parseInt(indexParam);
    const abonoIndexParam = req.params.abonoIndex;
    const abonoIndex = Array.isArray(abonoIndexParam) ? parseInt(abonoIndexParam[0]) : parseInt(abonoIndexParam);
    
    const { monto, fechaAbono } = req.body;
    
    const montoNum = parseFloat(monto);
    if (isNaN(montoNum) || montoNum <= 0) {
      res.status(400).json({ error: 'Monto de abono IVA inválido' });
      return;
    }
    
    const collection = (database as any).getCollection('proveedores');
    const proveedor = await collection.findOne({ _id: new ObjectId(id) });
    
    if (!proveedor) {
      res.status(404).json({ error: 'Proveedor no encontrado' });
      return;
    }
    
    if (!proveedor.facturas || index < 0 || index >= proveedor.facturas.length) {
      res.status(404).json({ error: 'Factura no encontrada' });
      return;
    }
    
    const factura = proveedor.facturas[index];
    const abonosIvaArray = factura.abonosIvaArray || [];
    
    if (abonoIndex < 0 || abonoIndex >= abonosIvaArray.length) {
      res.status(404).json({ error: 'Abono IVA no encontrado' });
      return;
    }
    
    const montoAnterior = abonosIvaArray[abonoIndex].monto;
    const diferencia = montoNum - montoAnterior;
    
    abonosIvaArray[abonoIndex] = {
      monto: montoNum,
      fecha: fechaAbono ? new Date(fechaAbono + 'T00:00:00') : new Date(),
    };
    
    const nuevoAbonoIva = (factura.abonosIva || 0) + diferencia;
    const deudaIva = (factura.iva75 || 0) - nuevoAbonoIva;
    
    proveedor.facturas[index] = {
      ...factura,
      abonosIva: nuevoAbonoIva,
      abonosIvaArray: abonosIvaArray,
      deudaIva: deudaIva < 0 ? 0 : deudaIva,
    };
    
    await collection.updateOne(
      { _id: new ObjectId(id) },
      { $set: { facturas: proveedor.facturas } }
    );
    res.json({ success: true });
  } catch (error: any) {
    console.error('Error actualizando abono IVA:', error);
    res.status(500).json({ error: 'Error al actualizar abono IVA', details: error.message });
  }
});

app.delete('/api/proveedores/:id/facturas/:index/abonos-iva/:abonoIndex', async (req: Request, res: Response) => {
  try {
    const { ObjectId } = await import('mongodb');
    const idParam = req.params.id;
    const id = Array.isArray(idParam) ? idParam[0] : idParam;
    const indexParam = req.params.index;
    const index = Array.isArray(indexParam) ? parseInt(indexParam[0]) : parseInt(indexParam);
    const abonoIndexParam = req.params.abonoIndex;
    const abonoIndex = Array.isArray(abonoIndexParam) ? parseInt(abonoIndexParam[0]) : parseInt(abonoIndexParam);
    
    const collection = (database as any).getCollection('proveedores');
    const proveedor = await collection.findOne({ _id: new ObjectId(id) });
    
    if (!proveedor) {
      res.status(404).json({ error: 'Proveedor no encontrado' });
      return;
    }
    
    if (!proveedor.facturas || index < 0 || index >= proveedor.facturas.length) {
      res.status(404).json({ error: 'Factura no encontrada' });
      return;
    }
    
    const factura = proveedor.facturas[index];
    const abonosIvaArray = factura.abonosIvaArray || [];
    
    if (abonoIndex < 0 || abonoIndex >= abonosIvaArray.length) {
      res.status(404).json({ error: 'Abono IVA no encontrado' });
      return;
    }
    
    const montoEliminado = abonosIvaArray[abonoIndex].monto;
    abonosIvaArray.splice(abonoIndex, 1);
    
    const nuevoAbonoIva = (factura.abonosIva || 0) - montoEliminado;
    const deudaIva = (factura.iva75 || 0) - nuevoAbonoIva;
    
    proveedor.facturas[index] = {
      ...factura,
      abonosIva: nuevoAbonoIva,
      abonosIvaArray: abonosIvaArray,
      deudaIva: deudaIva < 0 ? 0 : deudaIva,
    };
    
    await collection.updateOne(
      { _id: new ObjectId(id) },
      { $set: { facturas: proveedor.facturas } }
    );
    res.json({ success: true });
  } catch (error: any) {
    console.error('Error eliminando abono IVA:', error);
    res.status(500).json({ error: 'Error al eliminar abono IVA', details: error.message });
  }
});

app.put('/api/proveedores/:id/facturas/:index/abonos-iva25/:abonoIndex', async (req: Request, res: Response) => {
  try {
    const { ObjectId } = await import('mongodb');
    const idParam = req.params.id;
    const id = Array.isArray(idParam) ? idParam[0] : idParam;
    const indexParam = req.params.index;
    const index = Array.isArray(indexParam) ? parseInt(indexParam[0]) : parseInt(indexParam);
    const abonoIndexParam = req.params.abonoIndex;
    const abonoIndex = Array.isArray(abonoIndexParam) ? parseInt(abonoIndexParam[0]) : parseInt(abonoIndexParam);
    
    const { monto, fechaAbono } = req.body;
    
    const montoNum = parseFloat(monto);
    if (isNaN(montoNum) || montoNum <= 0) {
      res.status(400).json({ error: 'Monto de abono IVA 25% inválido' });
      return;
    }
    
    const collection = (database as any).getCollection('proveedores');
    const proveedor = await collection.findOne({ _id: new ObjectId(id) });
    
    if (!proveedor) {
      res.status(404).json({ error: 'Proveedor no encontrado' });
      return;
    }
    
    if (!proveedor.facturas || index < 0 || index >= proveedor.facturas.length) {
      res.status(404).json({ error: 'Factura no encontrada' });
      return;
    }
    
    const factura = proveedor.facturas[index];
    const abonosIva25Array = factura.abonosIva25Array || [];
    
    if (abonoIndex < 0 || abonoIndex >= abonosIva25Array.length) {
      res.status(404).json({ error: 'Abono IVA 25% no encontrado' });
      return;
    }
    
    const montoAnterior = abonosIva25Array[abonoIndex].monto;
    const diferencia = montoNum - montoAnterior;
    
    abonosIva25Array[abonoIndex] = {
      monto: montoNum,
      fecha: fechaAbono ? new Date(fechaAbono + 'T00:00:00') : new Date(),
    };
    
    const nuevoAbonoIva25 = (factura.abonosIva25 || 0) + diferencia;
    const deudaIva25 = (factura.iva25 || 0) - nuevoAbonoIva25;
    
    proveedor.facturas[index] = {
      ...factura,
      abonosIva25: nuevoAbonoIva25,
      abonosIva25Array: abonosIva25Array,
      deudaIva25: deudaIva25 < 0 ? 0 : deudaIva25,
    };
    
    await collection.updateOne(
      { _id: new ObjectId(id) },
      { $set: { facturas: proveedor.facturas } }
    );
    res.json({ success: true });
  } catch (error: any) {
    console.error('Error actualizando abono IVA 25%:', error);
    res.status(500).json({ error: 'Error al actualizar abono IVA 25%', details: error.message });
  }
});

app.delete('/api/proveedores/:id/facturas/:index/abonos-iva25/:abonoIndex', async (req: Request, res: Response) => {
  try {
    const { ObjectId } = await import('mongodb');
    const idParam = req.params.id;
    const id = Array.isArray(idParam) ? idParam[0] : idParam;
    const indexParam = req.params.index;
    const index = Array.isArray(indexParam) ? parseInt(indexParam[0]) : parseInt(indexParam);
    const abonoIndexParam = req.params.abonoIndex;
    const abonoIndex = Array.isArray(abonoIndexParam) ? parseInt(abonoIndexParam[0]) : parseInt(abonoIndexParam);
    
    const collection = (database as any).getCollection('proveedores');
    const proveedor = await collection.findOne({ _id: new ObjectId(id) });
    
    if (!proveedor) {
      res.status(404).json({ error: 'Proveedor no encontrado' });
      return;
    }
    
    if (!proveedor.facturas || index < 0 || index >= proveedor.facturas.length) {
      res.status(404).json({ error: 'Factura no encontrada' });
      return;
    }
    
    const factura = proveedor.facturas[index];
    const abonosIva25Array = factura.abonosIva25Array || [];
    
    if (abonoIndex < 0 || abonoIndex >= abonosIva25Array.length) {
      res.status(404).json({ error: 'Abono IVA 25% no encontrado' });
      return;
    }
    
    const montoEliminado = abonosIva25Array[abonoIndex].monto;
    abonosIva25Array.splice(abonoIndex, 1);
    
    const nuevoAbonoIva25 = (factura.abonosIva25 || 0) - montoEliminado;
    const deudaIva25 = (factura.iva25 || 0) - nuevoAbonoIva25;
    
    proveedor.facturas[index] = {
      ...factura,
      abonosIva25: nuevoAbonoIva25,
      abonosIva25Array: abonosIva25Array,
      deudaIva25: deudaIva25 < 0 ? 0 : deudaIva25,
    };
    
    await collection.updateOne(
      { _id: new ObjectId(id) },
      { $set: { facturas: proveedor.facturas } }
    );
    res.json({ success: true });
  } catch (error: any) {
    console.error('Error eliminando abono IVA 25%:', error);
    res.status(500).json({ error: 'Error al eliminar abono IVA 25%', details: error.message });
  }
});

app.delete('/api/proveedores/:id/facturas/:index', async (req: Request, res: Response) => {
  try {
    const { ObjectId } = await import('mongodb');
    const idParam = req.params.id;
    const id = Array.isArray(idParam) ? idParam[0] : idParam;
    const indexParam = req.params.index;
    const index = Array.isArray(indexParam) ? parseInt(indexParam[0]) : parseInt(indexParam);
    
    const collection = (database as any).getCollection('proveedores');
    const proveedor = await collection.findOne({ _id: new ObjectId(id) });
    
    if (!proveedor || !proveedor.facturas || index < 0 || index >= proveedor.facturas.length) {
      res.status(404).json({ error: 'Factura no encontrada' });
      return;
    }
    
    proveedor.facturas.splice(index, 1);
    await collection.updateOne(
      { _id: new ObjectId(id) },
      { $set: { facturas: proveedor.facturas } }
    );
    res.json({ success: true });
  } catch (error) {
    console.error('Error eliminando factura:', error);
    res.status(500).json({ error: 'Error al eliminar factura' });
  }
});

app.put('/api/proveedores/:id/factura/:index/comentario', async (req: Request, res: Response) => {
  try {
    const { ObjectId } = await import('mongodb');
    const idParam = req.params.id;
    const id = Array.isArray(idParam) ? idParam[0] : idParam;
    const indexParam = req.params.index;
    const index = Array.isArray(indexParam) ? parseInt(indexParam[0]) : parseInt(indexParam);
    
    const { comentario } = req.body;
    
    const collection = (database as any).getCollection('proveedores');
    const proveedor = await collection.findOne({ _id: new ObjectId(id) });
    
    if (!proveedor || !proveedor.facturas || index < 0 || index >= proveedor.facturas.length) {
      res.status(404).json({ error: 'Factura no encontrada' });
      return;
    }
    
    const updateKey = `facturas.${index}.comentario`;
    await collection.updateOne(
      { _id: new ObjectId(id) },
      { $set: { [updateKey]: comentario } }
    );
    
    res.json({ success: true, comentario });
  } catch (error) {
    console.error('Error actualizando comentario:', error);
    res.status(500).json({ error: 'Error al actualizar comentario' });
  }
});

app.use(invalidateCache);
app.use(withCache(300));

app.use('/api/marcas', marcasRoutes);
app.use('/api/lineas', lineasRoutes);
app.use('/api/ofertas', ofertasRoutes);
app.use('/api/auth', authRoutes);
app.use('/api/products', productsRoutes);
app.use('/api/home', homeRoutes);
app.use('/api/orders', ordersRoutes);
app.use('/api/roles', rolesRoutes);
app.use('/api/chat', chatRoutes);
app.use('/api/cierre-caja', cierreCajaRoutes);

// Galería - Documentos Temporales y Legales
app.get('/api/galeria/:tipo', async (req: Request, res: Response) => {
  try {
    const tipoParam = req.params.tipo;
    const tipo = Array.isArray(tipoParam) ? tipoParam[0] : tipoParam;
    const collectionName = tipo === 'temporales' ? 'documentos-temporales' : 'documentos-legales';
    const collection = (database as any).getCollection(collectionName);
    const docs = await collection.find({}).sort({ fechaSubida: -1 }).toArray();
    res.json(docs);
  } catch (error) {
    console.error('Error obteniendo documentos galería:', error);
    res.status(500).json({ error: 'Error al obtener documentos' });
  }
});

app.post('/api/galeria/:tipo', async (req: Request, res: Response) => {
  try {
    const tipoParam = req.params.tipo;
    const tipo = Array.isArray(tipoParam) ? tipoParam[0] : tipoParam;
    const collectionName = tipo === 'temporales' ? 'documentos-temporales' : 'documentos-legales';
    const { nombre, descripcion, imagenes } = req.body;
    if (!nombre) {
      res.status(400).json({ error: 'El nombre es requerido' });
      return;
    }
    const collection = (database as any).getCollection(collectionName);
    const doc: any = {
      nombre,
      descripcion: descripcion || '',
      imagenes: imagenes || [],
      fechaSubida: new Date(),
    };
    const result = await collection.insertOne(doc);
    res.json({ ...doc, _id: result.insertedId });
  } catch (error) {
    console.error('Error creando documento galería:', error);
    res.status(500).json({ error: 'Error al crear documento' });
  }
});

app.put('/api/galeria/:tipo/:id', async (req: Request, res: Response) => {
  try {
    const { ObjectId } = await import('mongodb');
    const tipoParam = req.params.tipo;
    const tipo = Array.isArray(tipoParam) ? tipoParam[0] : tipoParam;
    const idParam = req.params.id;
    const id = Array.isArray(idParam) ? idParam[0] : idParam;
    const collectionName = tipo === 'temporales' ? 'documentos-temporales' : 'documentos-legales';
    const { nombre, descripcion, imagenes } = req.body;
    const collection = (database as any).getCollection(collectionName);
    const updateData: any = { nombre, descripcion };
    if (imagenes !== undefined) updateData.imagenes = imagenes;
    await collection.updateOne({ _id: new ObjectId(id) }, { $set: updateData });
    res.json({ success: true });
  } catch (error) {
    console.error('Error actualizando documento galería:', error);
    res.status(500).json({ error: 'Error al actualizar documento' });
  }
});

app.delete('/api/galeria/:tipo/:id', async (req: Request, res: Response) => {
  try {
    const { ObjectId } = await import('mongodb');
    const tipoParam = req.params.tipo;
    const tipo = Array.isArray(tipoParam) ? tipoParam[0] : tipoParam;
    const idParam = req.params.id;
    const id = Array.isArray(idParam) ? idParam[0] : idParam;
    const collectionName = tipo === 'temporales' ? 'documentos-temporales' : 'documentos-legales';
    const collection = (database as any).getCollection(collectionName);
    await collection.deleteOne({ _id: new ObjectId(id) });
    res.json({ success: true });
  } catch (error) {
    console.error('Error eliminando documento galería:', error);
    res.status(500).json({ error: 'Error al eliminar documento' });
  }
});

const galeriaTokens = new Map<string, { tipo: string; docId: string; expiresAt: Date }>();

app.post('/api/galeria/:tipo/generate-qr', async (req: Request, res: Response) => {
  try {
    const tipoParam = req.params.tipo;
    const tipo = Array.isArray(tipoParam) ? tipoParam[0] : tipoParam;
    const { docId } = req.body;
    const token = randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000);

    galeriaTokens.set(token, { tipo, docId, expiresAt });

    const host = req.get('host');
    const isLocalhost = host?.includes('localhost') || host?.includes('127.0.0.1');
    const baseUrl = process.env.BASE_URL || (isLocalhost ? `http://${host}` : `https://${host}`);
    const uploadUrl = `${baseUrl}/upload-galeria/${token}`;

    const qrApiUrl = `https://api.qrserver.com/v1/create-qr-code/?size=250x250&margin=1&data=${encodeURIComponent(uploadUrl)}`;

    try {
      const response = await fetch(qrApiUrl);
      const buffer = await response.arrayBuffer();
      const base64 = Buffer.from(buffer).toString('base64');
      const dataUrl = `data:image/png;base64,${base64}`;
      res.json({ qrCode: dataUrl, uploadUrl, expiresAt: expiresAt.toISOString() });
    } catch (fetchError) {
      console.error('Error fetching QR galería:', fetchError);
      res.json({ qrCode: qrApiUrl, uploadUrl, expiresAt: expiresAt.toISOString() });
    }
  } catch (error) {
    console.error('Error generating QR galería:', error);
    res.status(500).json({ error: 'Error al generar código QR' });
  }
});

app.post('/api/galeria/:tipo/:docId/upload', async (req: Request, res: Response) => {
  try {
    const { ObjectId } = await import('mongodb');
    const tipoParam = req.params.tipo;
    const tipo = Array.isArray(tipoParam) ? tipoParam[0] : tipoParam;
    const docIdParam = req.params.docId;
    const docId = Array.isArray(docIdParam) ? docIdParam[0] : docIdParam;
    const { imagen, token } = req.body;
    const collectionName = tipo === 'temporales' ? 'documentos-temporales' : 'documentos-legales';
    const collection = (database as any).getCollection(collectionName);
    await collection.updateOne(
      { _id: new ObjectId(docId) },
      { $push: { imagenes: imagen } }
    );
    if (token) galeriaTokens.delete(token);
    res.json({ success: true });
  } catch (error) {
    console.error('Error subiendo imagen galería:', error);
    res.status(500).json({ error: 'Error al subir imagen' });
  }
});

app.get('/api/galeria/:tipo/imagenes/:docId', async (req: Request, res: Response) => {
  try {
    const { ObjectId } = await import('mongodb');
    const tipoParam = req.params.tipo;
    const tipo = Array.isArray(tipoParam) ? tipoParam[0] : tipoParam;
    const docIdParam = req.params.docId;
    const docId = Array.isArray(docIdParam) ? docIdParam[0] : docIdParam;
    const collectionName = tipo === 'temporales' ? 'documentos-temporales' : 'documentos-legales';
    const collection = (database as any).getCollection(collectionName);
    const doc = await collection.findOne({ _id: new ObjectId(docId) });
    if (!doc) {
      res.status(404).json({ error: 'Documento no encontrado' });
      return;
    }
    res.json({ imagenes: doc.imagenes || [] });
  } catch (error) {
    console.error('Error obteniendo imágenes galería:', error);
    res.status(500).json({ error: 'Error al obtener imágenes' });
  }
});

app.delete('/api/galeria/:tipo/imagenes/:docId/:imagenIndex', async (req: Request, res: Response) => {
  try {
    const { ObjectId } = await import('mongodb');
    const tipoParam = req.params.tipo;
    const tipo = Array.isArray(tipoParam) ? tipoParam[0] : tipoParam;
    const docIdParam = req.params.docId;
    const docId = Array.isArray(docIdParam) ? docIdParam[0] : docIdParam;
    const imagenIndexParam = req.params.imagenIndex;
    const imagenIndex = Array.isArray(imagenIndexParam) ? parseInt(imagenIndexParam[0]) : parseInt(imagenIndexParam);
    const collectionName = tipo === 'temporales' ? 'documentos-temporales' : 'documentos-legales';
    const collection = (database as any).getCollection(collectionName);
    const doc = await collection.findOne({ _id: new ObjectId(docId) });
    if (!doc) {
      res.status(404).json({ error: 'Documento no encontrado' });
      return;
    }
    const imagenes = doc.imagenes || [];
    if (imagenIndex >= 0 && imagenIndex < imagenes.length) {
      imagenes.splice(imagenIndex, 1);
      await collection.updateOne({ _id: new ObjectId(docId) }, { $set: { imagenes } });
    }
    res.json({ success: true });
  } catch (error) {
    console.error('Error eliminando imagen galería:', error);
    res.status(500).json({ error: 'Error al eliminar imagen' });
  }
});

app.get('/upload-galeria/:token', async (req: Request, res: Response) => {
  const tokenParam = req.params.token;
  const token = Array.isArray(tokenParam) ? tokenParam[0] : tokenParam;
  const uploadData = galeriaTokens.get(token);

  if (!uploadData || new Date() > uploadData.expiresAt) {
    galeriaTokens.delete(token);
    res.send(`<!DOCTYPE html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><title>Enlace expirado</title><style>body{font-family:Arial;padding:20px;text-align:center}.error{color:red}</style></head><body><h1 class="error">Enlace expirado o inválido</h1><p>Genera un nuevo código QR desde la aplicación.</p></body></html>`);
    return;
  }

  res.send(`<!DOCTYPE html>
<html><head><meta name="viewport" content="width=device-width, initial-scale=1"><title>Subir Imagen</title>
<style>
*{box-sizing:border-box}
body{font-family:Arial,sans-serif;padding:20px;max-width:500px;margin:0 auto}
h1{text-align:center;color:#333;font-size:1.3rem}
.upload-area{border:2px dashed #ccc;border-radius:10px;padding:30px;text-align:center;margin:20px 0;cursor:pointer}
.upload-area:hover{border-color:#1976d2;background:#f8f9fa}
input[type=file]{display:none}
.btn-camera{background:#25D366;color:white;padding:15px 30px;border:none;border-radius:8px;font-size:16px;cursor:pointer;display:block;width:100%;margin:10px 0}
.btn-camera:hover{background:#20BD5A}
.btn-gallery{background:#1976d2;color:white;padding:15px 30px;border:none;border-radius:8px;font-size:16px;cursor:pointer;display:block;width:100%;margin:10px 0}
.btn-gallery:hover{background:#1565c0}
.preview{margin-top:20px;text-align:center}
.preview img{max-width:100%;border-radius:8px}
.btn-upload{background:#4CAF50;color:white;padding:15px 30px;border:none;border-radius:8px;font-size:16px;cursor:pointer;width:100%;margin-top:10px}
.btn-upload:hover{background:#45a049}
.btn-upload:disabled{background:#ccc;cursor:not-allowed}
.success{text-align:center;padding:40px 20px}
.success h2{color:#4CAF50}
.progress{text-align:center;color:#666}
</style></head>
<body>
<h1>Subir Imagen</h1>
<div class="upload-area" onclick="document.getElementById('cameraInput').click()">
<p>Toca para tomar foto</p>
</div>
<input type="file" id="cameraInput" accept="image/*" capture="environment">
<div class="upload-area" onclick="document.getElementById('galleryInput').click()">
<p>Toca para seleccionar de galería</p>
</div>
<input type="file" id="galleryInput" accept="image/*">
<div id="previewArea" class="preview" style="display:none">
<img id="previewImg" src="">
<button id="uploadBtn" class="btn-upload" onclick="uploadImage()">📤 Subir Imagen</button>
</div>
<div id="progress" class="progress" style="display:none"><p>Subiendo...</p></div>
<div id="success" class="success" style="display:none"><h2>✓ Imagen subida</h2><p>Puedes subir otra o cerrar esta página.</p></div>
<script>
let selectedFile=null;
function handleFile(e){const file=e.target.files[0];if(!file)return;selectedFile=file;const reader=new FileReader();reader.onload=function(ev){document.getElementById('previewImg').src=ev.target.result;document.getElementById('previewArea').style.display='block';document.getElementById('success').style.display='none';};reader.readAsDataURL(file);}
document.getElementById('cameraInput').addEventListener('change',handleFile);
document.getElementById('galleryInput').addEventListener('change',handleFile);
function resizeImage(base64,maxWidth){return new Promise(resolve=>{const img=new Image();img.onload=function(){const canvas=document.createElement('canvas');let w=img.width,h=img.height;if(w>maxWidth){h=Math.round(h*maxWidth/w);w=maxWidth;}canvas.width=w;canvas.height=h;const ctx=canvas.getContext('2d');ctx.drawImage(img,0,0,w,h);resolve(canvas.toDataURL('image/jpeg',0.8));};img.src=base64;});}
async function uploadImage(){if(!selectedFile)return;document.getElementById('uploadBtn').disabled=true;document.getElementById('progress').style.display='block';const reader=new FileReader();reader.onload=async function(ev){const resized=await resizeImage(ev.target.result,1200);try{await fetch('/api/galeria/${uploadData.tipo}/${uploadData.docId}/upload',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({imagen:resized,token:'${token}'}),});document.getElementById('progress').style.display='none';document.getElementById('success').style.display='block';document.getElementById('previewArea').style.display='none';selectedFile=null;document.getElementById('uploadBtn').disabled=false;}catch(err){alert('Error al subir');document.getElementById('uploadBtn').disabled=false;document.getElementById('progress').style.display='none';}};reader.readAsDataURL(selectedFile);}
</script></body></html>`);
});

const uploadTokens = new Map<string, { proveedorId: string; facturaIndex: number; expiresAt: Date }>();

// ============ SISTEMA QR PARA FACTURAS (NUEVO) ============

const facturasQrTokens = new Map<string, { 
  proveedorId: string; 
  facturaIndex: number; 
  expiresAt: Date;
  imagen?: string;
  datosExtraidos?: any;
}>();

app.post('/api/facturas-qr/generate-qr', async (req: Request, res: Response) => {
  try {
    const { proveedorId, facturaIndex } = req.body;
    const token = randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000);
    
    facturasQrTokens.set(token, { proveedorId, facturaIndex, expiresAt });
    
    const host = req.get('host');
    const isLocalhost = host?.includes('localhost') || host?.includes('127.0.0.1');
    const baseUrl = process.env.BASE_URL || (isLocalhost ? `http://${host}` : `https://${host}`);
    const uploadUrl = `${baseUrl}/facturas-qr/upload/${token}`;
    
    const qrApiUrl = `https://api.qrserver.com/v1/create-qr-code/?size=250x250&margin=1&data=${encodeURIComponent(uploadUrl)}`;

    try {
      const response = await fetch(qrApiUrl);
      const buffer = await response.arrayBuffer();
      const base64 = Buffer.from(buffer).toString('base64');
      const qrCodeDataUrl = `data:image/png;base64,${base64}`;
      res.json({ 
        qrCode: qrCodeDataUrl, 
        token,
        uploadUrl, 
        expiresAt: expiresAt.toISOString() 
      });
    } catch (fetchError) {
      console.error('Error fetching QR:', fetchError);
      res.json({ qrCode: qrApiUrl, token, uploadUrl, expiresAt: expiresAt.toISOString() });
    }
  } catch (error) {
    console.error('Error generating QR:', error);
    res.status(500).json({ error: 'Error al generar código QR' });
  }
});

app.get('/api/facturas-qr/check/:token', async (req: Request, res: Response) => {
  const token = Array.isArray(req.params.token) ? req.params.token[0] : req.params.token;
  const tokenData = facturasQrTokens.get(token);
  
  console.log('Facturas QR check - token:', token, 'found:', !!tokenData, 'hasImage:', !!tokenData?.imagen);
  
  if (!tokenData) {
    return res.status(404).json({ success: false, error: 'Token no válido' });
  }
  
  if (new Date() > tokenData.expiresAt) {
    facturasQrTokens.delete(token);
    return res.status(410).json({ success: false, error: 'Token expirado' });
  }
  
  if (tokenData.imagen) {
    console.log('Facturas QR - Retornando imagen de', tokenData.imagen.length, 'bytes');
    facturasQrTokens.delete(token);
    return res.json({ 
      success: true, 
      imagen: tokenData.imagen,
      datosExtraidos: tokenData.datosExtraidos
    });
  }
  
  res.json({ success: false });
});

app.get('/api/facturas-qr/imagenes/:proveedorId/:facturaIndex', async (req: Request, res: Response) => {
  try {
    const { ObjectId } = await import('mongodb');
    const proveedorIdParam = req.params.proveedorId;
    const proveedorId = Array.isArray(proveedorIdParam) ? proveedorIdParam[0] : proveedorIdParam;
    const facturaIndexParam = req.params.facturaIndex;
    const facturaIndex = Array.isArray(facturaIndexParam) ? parseInt(facturaIndexParam[0]) : parseInt(facturaIndexParam);
    
    const proveedor = await (database as any).getCollection('proveedores').findOne({ _id: new ObjectId(proveedorId) });
    if (!proveedor) {
      res.status(404).json({ error: 'Proveedor no encontrado' });
      return;
    }
    
    const facturas = proveedor.facturas || [];
    const factura = facturas[facturaIndex];
    if (!factura) {
      res.status(404).json({ error: 'Factura no encontrada' });
      return;
    }
    
    res.json({ imagenes: factura.imagenes || [] });
  } catch (error) {
    console.error('Error obteniendo imágenes de factura:', error);
    res.status(500).json({ error: 'Error al obtener imágenes' });
  }
});

app.get('/facturas-qr/upload/:token', async (req: Request, res: Response) => {
  const token = Array.isArray(req.params.token) ? req.params.token[0] : req.params.token;
  const tokenData = facturasQrTokens.get(token);
  
  console.log('=== FACTURAS QR UPLOAD PAGE ===');
  console.log('Full URL:', req.protocol + '://' + req.get('host') + req.originalUrl);
  console.log('Token:', token);
  console.log('Token exists:', !!tokenData);
  console.log('All tokens in map:', Array.from(facturasQrTokens.keys()));
  
  if (!tokenData) {
    return res.send(`
      <!DOCTYPE html>
      <html>
      <head>
        <title>Enlace expirado</title>
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <style>
          body { font-family: Arial, sans-serif; padding: 20px; text-align: center; background: #f5f5f5; }
          .error { color: red; background: white; padding: 20px; border-radius: 10px; }
        </style>
      </head>
      <body>
        <div class="error">
          <h1>⚠️ Enlace expirado o inválido</h1>
          <p>Por favor genera un nuevo código QR desde la aplicación.</p>
        </div>
      </body>
      </html>
    `);
  }
  
  if (new Date() > tokenData.expiresAt) {
    facturasQrTokens.delete(token);
    return res.send(`
      <!DOCTYPE html>
      <html>
      <head>
        <title>Enlace expirado</title>
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <style>
          body { font-family: Arial, sans-serif; padding: 20px; text-align: center; background: #f5f5f5; }
          .error { color: red; background: white; padding: 20px; border-radius: 10px; }
        </style>
      </head>
      <body>
        <div class="error">
          <h1>⏰ El enlace ha expirado</h1>
          <p>Por favor genera un nuevo código QR desde la aplicación.</p>
        </div>
      </body>
      </html>
    `);
  }
  
  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>Subir foto de factura</title>
      <meta name="viewport" content="width=device-width, initial-scale=1">
      <style>
        * { box-sizing: border-box; }
        body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; padding: 20px; background: #f0f2f5; margin: 0; }
        .container { max-width: 500px; margin: 0 auto; }
        h1 { text-align: center; color: #1a1a1a; margin-bottom: 20px; }
        .upload-card { background: white; border-radius: 15px; padding: 30px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); }
        .upload-area {
          border: 2px dashed #ddd;
          border-radius: 12px;
          padding: 40px 20px;
          text-align: center;
          cursor: pointer;
          transition: all 0.3s;
        }
        .upload-area:hover { border-color: #007bff; background: #f8f9ff; }
        .upload-area.uploading { border-color: #28a745; background: #f0fff4; }
        input[type="file"] { display: none; }
        .btn-camera {
          background: linear-gradient(135deg, #007bff, #0056b3);
          color: white;
          padding: 16px 32px;
          border: none;
          border-radius: 8px;
          font-size: 16px;
          cursor: pointer;
          width: 100%;
          font-weight: 600;
        }
        .btn-camera:hover { transform: translateY(-2px); box-shadow: 0 4px 12px rgba(0,123,255,0.3); }
        .preview { margin-top: 20px; text-align: center; }
        .preview img { max-width: 100%; border-radius: 10px; box-shadow: 0 2px 8px rgba(0,0,0,0.1); }
        .status { padding: 15px; margin: 15px 0; border-radius: 8px; text-align: center; }
        .status.success { background: #d4edda; color: #155724; }
        .status.error { background: #f8d7da; color: #721c24; }
        .status.loading { background: #fff3cd; color: #856404; }
        .success-icon { font-size: 48px; margin-bottom: 10px; }
        .checkbox-container { margin: 20px 0; display: flex; align-items: center; justify-content: center; }
        .checkbox-container input { width: auto; margin-right: 8px; }
        .checkbox-container label { color: #555; }
      </style>
    </head>
    <body>
      <div class="container">
        <h1>📷 Subir Foto de Factura</h1>
        <div class="upload-card">
          <div class="checkbox-container">
            <input type="checkbox" id="extraerDatos">
            <label for="extraerDatos">🤖 Extraer datos automáticamente</label>
          </div>
          <div class="upload-area" id="uploadArea" onclick="document.getElementById('fileInput').click()">
            <input type="file" id="fileInput" accept="image/*" capture="environment" onchange="handleFileSelect(event)">
            <button class="btn-camera">📸 Tomar foto o seleccionar</button>
            <p id="statusText" style="margin-top: 10px; color: #666;">Haz clic para seleccionar una imagen</p>
          </div>
          <div class="preview" id="preview"></div>
          <div id="loadingStatus" class="status loading" style="display:none;">
            ⏳ Subiendo imagen...
          </div>
        </div>
      </div>
      <script>
        const token = window.location.pathname.split('/facturas-qr/upload/')[1] || '';
        console.log('Token:', token);
        
        function handleFileSelect(event) {
          const file = event.target.files[0];
          if (!file) return;
          
          console.log('Archivo seleccionado:', file.name, file.size);
          
          const reader = new FileReader();
          reader.onload = function(e) {
            const base64 = e.target.result;
            document.getElementById('preview').innerHTML = '<img src="' + base64 + '" alt="Preview">';
            uploadImage(base64);
          };
          reader.readAsDataURL(file);
        }
        
        async function uploadImage(base64) {
          const extraerDatos = document.getElementById('extraerDatos').checked;
          const uploadArea = document.getElementById('uploadArea');
          const statusText = document.getElementById('statusText');
          const loadingStatus = document.getElementById('loadingStatus');
          
          uploadArea.classList.add('uploading');
          loadingStatus.style.display = 'block';
          loadingStatus.textContent = extraerDatos ? '🤖 Procesando imagen y extrayendo datos...' : '⏳ Subiendo imagen...';
          
          try {
            const response = await fetch('/api/facturas-qr/upload', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ token, imagen: base64, extraerDatos })
            });
            
            const data = await response.json();
            console.log('Response:', data);
            
            if (response.ok && data.success) {
              loadingStatus.className = 'status success';
              loadingStatus.innerHTML = '✅ ¡Foto subida exitosamente!<br><small>Cerrando en 3 segundos...</small>';
              setTimeout(() => window.close(), 3000);
            } else {
              loadingStatus.className = 'status error';
              loadingStatus.textContent = '❌ Error: ' + (data.error || 'Error al subir');
            }
          } catch (err) {
            loadingStatus.className = 'status error';
            loadingStatus.textContent = '❌ Error de conexión: ' + err.message;
          }
          
          uploadArea.classList.remove('uploading');
        }
      </script>
    </body>
    </html>
  `);
});

app.post('/api/facturas-qr/upload', async (req: Request, res: Response) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  
  if (req.method === 'OPTIONS') {
    return res.status(200).send();
  }
  
  try {
    const { token, imagen, extraerDatos } = req.body;
    const tokenData = facturasQrTokens.get(token);
    
    console.log('Facturas QR upload - token:', token, 'found:', !!tokenData);
    
    if (!tokenData) {
      return res.status(400).json({ success: false, error: 'Token inválido' });
    }
    
    if (new Date() > tokenData.expiresAt) {
      facturasQrTokens.delete(token);
      return res.status(400).json({ success: false, error: 'Token expirado' });
    }
    
    const { proveedorId, facturaIndex } = tokenData;
    
    const { ObjectId } = await import('mongodb');
    const proveedorCollection = (database as any).getCollection('proveedores');
    
    await proveedorCollection.updateOne(
      { _id: new ObjectId(proveedorId) },
      { $push: { [`facturas.${facturaIndex}.imagenes`]: imagen } }
    );
    
    console.log('Imagen guardada directamente en factura', proveedorId, facturaIndex);
    
    // Guardamos la imagen en el token para que el polling del frontend la detecte
    tokenData.imagen = imagen;
    
    let datosExtraidos = null;
    if (extraerDatos && imagen) {
      try {
        const result = await Tesseract.recognize(imagen, 'spa+eng', { logger: m => console.log('OCR:', m) });
        datosExtraidos = extraerDatosFactura(result.data.text);
        console.log('Datos extraídos:', datosExtraidos);
      } catch (ocrError) {
        console.error('Error en OCR:', ocrError);
      }
    }
    
    res.json({ success: true, datosExtraidos });
  } catch (error) {
    console.error('Error uploading photo:', error);
    res.status(500).json({ success: false, error: 'Error al guardar la foto' });
  }
});

app.post('/api/proveedores/:id/facturas/:index/imagen', async (req: Request, res: Response) => {
  try {
    const { ObjectId } = await import('mongodb');
    const idParam = req.params.id;
    const id = Array.isArray(idParam) ? idParam[0] : idParam;
    const indexParam = req.params.index;
    const index = Array.isArray(indexParam) ? parseInt(indexParam[0]) : parseInt(indexParam);
    const { imagen } = req.body;
    
    if (!imagen) {
      return res.status(400).json({ error: 'Imagen requerida' });
    }
    
    const collection = (database as any).getCollection('proveedores');
    const proveedor = await collection.findOne({ _id: new ObjectId(id) });
    
    if (!proveedor) {
      return res.status(404).json({ error: 'Proveedor no encontrado' });
    }
    
    if (!proveedor.facturas || index < 0 || index >= proveedor.facturas.length) {
      return res.status(404).json({ error: 'Factura no encontrada' });
    }
    
    await collection.updateOne(
      { _id: new ObjectId(id) },
      { $push: { [`facturas.${index}.imagenes`]: imagen } }
    );
    
    console.log('Imagen agregada a factura', index, 'del proveedor', id);
    res.json({ success: true });
  } catch (error) {
    console.error('Error adding image to factura:', error);
    res.status(500).json({ error: 'Error al agregar imagen' });
  }
});

app.get('/api/pago/debug/:token', async (req: Request, res: Response) => {
  const token = Array.isArray(req.params.token) ? req.params.token[0] : req.params.token;
  const collection = (database as any).getCollection('pagos');
  const tokenData = await collection.findOne({ token });
  res.json({ 
    token, 
    found: !!tokenData, 
    hasImage: !!tokenData?.imagen,
    expiresAt: tokenData?.expiresAt,
    imagenLength: tokenData?.imagen?.length
  });
});

app.post('/api/pago/generate-qr', async (req: Request, res: Response) => {
  try {
    const token = randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000);
    
    const collection = (database as any).getCollection('pagos');
    await collection.insertOne({
      token,
      expiresAt,
      createdAt: new Date()
    });
    
    const baseUrl = process.env.BASE_URL || `http://${req.get('host')}`;
    const uploadUrl = `${baseUrl}/upload-pago/${token}`;
    
    const qrApiUrl = `https://api.qrserver.com/v1/create-qr-code/?size=250x250&margin=1&data=${encodeURIComponent(uploadUrl)}`;
    
    try {
      const response = await fetch(qrApiUrl);
      const buffer = await response.arrayBuffer();
      const base64 = Buffer.from(buffer).toString('base64');
      const dataUrl = `data:image/png;base64,${base64}`;
      
      res.json({ qrCode: dataUrl, uploadUrl, expiresAt: expiresAt.toISOString() });
    } catch (fetchError) {
      console.error('Error fetching QR:', fetchError);
      res.json({ qrCode: qrApiUrl, uploadUrl, expiresAt: expiresAt.toISOString() });
    }
  } catch (error) {
    console.error('Error generating QR:', error);
    res.status(500).json({ error: 'Error al generar código QR' });
  }
});

app.get('/api/pago/check/:token', async (req: Request, res: Response) => {
  const token = Array.isArray(req.params.token) ? req.params.token[0] : req.params.token;
  
  const collection = (database as any).getCollection('pagos');
  const tokenData = await collection.findOne({ token });
  
  console.log('Check token:', token, 'found:', !!tokenData, 'hasImage:', !!tokenData?.imagen);
  
  if (!tokenData) {
    return res.json({ success: false, error: 'Token no válido' });
  }
  
  if (new Date() > new Date(tokenData.expiresAt)) {
    return res.json({ success: false, error: 'Token expirado' });
  }
  
  if (tokenData.imagen) {
    console.log('Retornando imagen de', tokenData.imagen.length, 'bytes');
    return res.json({ success: true, imagen: tokenData.imagen });
  }
  
  console.log('No hay imagen aún');
  res.json({ success: false });
});

app.get('/upload-pago/:token', async (req: Request, res: Response) => {
  const token = Array.isArray(req.params.token) ? req.params.token[0] : req.params.token;
  
  const collection = (database as any).getCollection('pagos');
  const tokenData = await collection.findOne({ token });
  
  if (!tokenData) {
    res.send(`
      <!DOCTYPE html>
      <html>
      <head>
        <title>Enlace expirado</title>
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <style>
          body { font-family: Arial, sans-serif; padding: 20px; text-align: center; }
          .error { color: red; }
        </style>
      </head>
      <body>
        <h1 class="error">Enlace expirado o inválido</h1>
        <p>Por favor genera un nuevo código QR desde la aplicación.</p>
      </body>
      </html>
    `);
    return;
  }
  
  if (new Date() > new Date(tokenData.expiresAt)) {
    res.send(`
      <!DOCTYPE html>
      <html>
      <head>
        <title>Enlace expirado</title>
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <style>
          body { font-family: Arial, sans-serif; padding: 20px; text-align: center; }
          .error { color: red; }
        </style>
      </head>
      <body>
        <h1 class="error">El enlace ha expirado</h1>
        <p>Por favor genera un nuevo código QR desde la aplicación.</p>
      </body>
      </html>
    `);
    return;
  }
  
  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>Subir comprobante de pago</title>
      <meta name="viewport" content="width=device-width, initial-scale=1">
      <style>
        * { box-sizing: border-box; }
        body { font-family: Arial, sans-serif; padding: 20px; max-width: 500px; margin: 0 auto; }
        h1 { text-align: center; color: #333; }
        .upload-area {
          border: 2px dashed #ccc;
          border-radius: 10px;
          padding: 30px;
          text-align: center;
          margin: 20px 0;
          cursor: pointer;
        }
        .upload-area:hover { border-color: #007bff; background: #f8f9fa; }
        input[type="file"] { display: none; }
        .btn-camera {
          background: #25D366;
          color: white;
          padding: 15px 30px;
          border: none;
          border-radius: 5px;
          font-size: 16px;
          cursor: pointer;
        }
        .btn-camera:hover { background: #20BD5A; }
        .preview { margin-top: 20px; }
        .preview img { max-width: 100%; border-radius: 5px; }
        .status { padding: 10px; margin: 10px 0; border-radius: 5px; }
        .status.success { background: #d4edda; color: #155724; }
        .status.error { background: #f8d7da; color: #721c24; }
        .loading { text-align: center; padding: 20px; }
        .btn-cerrar {
          margin-top: 15px;
          width: 100%;
          padding: 12px;
          background: #28a745;
          color: white;
          border: none;
          border-radius: 5px;
          font-size: 16px;
          cursor: pointer;
        }
        .btn-cerrar:hover { background: #218838; }
      </style>
    </head>
    <body>
      <h1>📷 Subir Comprobante de Pago</h1>
      <div class="upload-area" onclick="document.getElementById('fileInput').click()">
        <input type="file" id="fileInput" accept="image/*" capture="environment" onchange="handleFileSelect(event)">
        <button class="btn-camera">📸 Tomar foto o seleccionar</button>
        <p id="statusText"></p>
      </div>
      <div class="preview" id="preview"></div>
      <div class="loading" id="loading" style="display:none;">Subiendo imagen...</div>
      <script>
        let selectedFile = null;
        
        function handleFileSelect(event) {
          selectedFile = event.target.files[0];
          if (selectedFile) {
            const reader = new FileReader();
            reader.onload = function(e) {
              document.getElementById('preview').innerHTML = '<img src="' + e.target.result + '" alt="Preview">';
              uploadFile();
            };
            reader.readAsDataURL(selectedFile);
          }
        }
        
        async function uploadFile() {
          if (!selectedFile) return;
          
          document.getElementById('loading').style.display = 'block';
          document.getElementById('statusText').textContent = 'Subiendo imagen...';
          
          const formData = new FormData();
          formData.append('imagen', selectedFile);
          formData.append('token', '${token}');
          
          try {
            const response = await fetch('/api/pago/upload-photo', {
              method: 'POST',
              body: formData
            });
            const data = await response.json();
            
            document.getElementById('loading').style.display = 'none';
            
            if (data.success) {
              document.getElementById('statusText').textContent = '✅ ¡Foto subida exitosamente!';
              document.getElementById('statusText').className = 'status success';
              document.getElementById('preview').innerHTML += '<button onclick="window.close()" class="btn-cerrar">Cerrar</button>';
              setTimeout(() => {
                window.close();
              }, 3000);
            } else {
              document.getElementById('statusText').textContent = '❌ Error: ' + (data.error || 'Error al subir');
              document.getElementById('statusText').className = 'status error';
            }
          } catch (error) {
            document.getElementById('loading').style.display = 'none';
            document.getElementById('statusText').textContent = '❌ Error de conexión';
            document.getElementById('statusText').className = 'status error';
          }
        }
      </script>
    </body>
    </html>
  `);
});

app.post('/api/pago/upload-photo', multer({ limits: { fileSize: 10 * 1024 * 1024 } }).any(), async (req: Request, res: Response) => {
  try {
    console.log('Upload request received');
    console.log('Body:', req.body);
    console.log('Files:', req.files);
    
    const token = req.body?.token;
    const files = req.files as any[];
    const imagenFile = files?.find(f => f.fieldname === 'imagen');
    
    if (!token) {
      console.log('No token provided');
      return res.json({ success: false, error: 'Faltan datos: token' });
    }
    
    if (!imagenFile) {
      console.log('No image file provided');
      return res.json({ success: false, error: 'Faltan datos: imagen' });
    }
    
    const collection = (database as any).getCollection('pagos');
    const tokenData = await collection.findOne({ token });
    
    if (!tokenData) {
      console.log('Token no encontrado:', token);
      return res.json({ success: false, error: 'Token no válido' });
    }
    
    if (new Date() > new Date(tokenData.expiresAt)) {
      console.log('Token expirado');
      return res.json({ success: false, error: 'Token expirado' });
    }
    
    const imagen = `data:${imagenFile.mimetype};base64,${imagenFile.buffer.toString('base64')}`;
    
    await collection.updateOne(
      { token },
      { $set: { imagen } }
    );
    
    console.log('Foto guardada para token:', token);
    res.json({ success: true });
  } catch (error) {
    console.error('Error uploading photo:', error);
    res.json({ success: false, error: 'Error al procesar la imagen' });
  }
});

app.post('/api/facturas/generate-qr', authenticateToken, async (req: Request, res: Response) => {
  try {
    const { proveedorId, facturaIndex } = req.body;
    const token = randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000);
    
    uploadTokens.set(token, { proveedorId, facturaIndex, expiresAt });
    
    const host = req.get('host');
    const isLocalhost = host?.includes('localhost') || host?.includes('127.0.0.1');
    const baseUrl = process.env.BASE_URL || (isLocalhost ? `http://${host}` : `http://${host}`);
    const uploadUrl = `${baseUrl}/upload-factura/${token}`;
    
    const qrApiUrl = `https://api.qrserver.com/v1/create-qr-code/?size=250x250&margin=1&data=${encodeURIComponent(uploadUrl)}`;
    
    try {
      const response = await fetch(qrApiUrl);
      const buffer = await response.arrayBuffer();
      const base64 = Buffer.from(buffer).toString('base64');
      const dataUrl = `data:image/png;base64,${base64}`;
      
      res.json({ qrCode: dataUrl, uploadUrl, expiresAt: expiresAt.toISOString() });
    } catch (fetchError) {
      console.error('Error fetching QR:', fetchError);
      res.json({ qrCode: qrApiUrl, uploadUrl, expiresAt: expiresAt.toISOString() });
    }
  } catch (error) {
    console.error('Error generating QR:', error);
    res.status(500).json({ error: 'Error al generar código QR' });
  }
});

app.get('/api/facturas/imagenes/:proveedorId/:facturaIndex', async (req: Request, res: Response) => {
  try {
    const proveedorIdParam = req.params.proveedorId;
    const facturaIndexParam = req.params.facturaIndex;
    const proveedorId = Array.isArray(proveedorIdParam) ? proveedorIdParam[0] : proveedorIdParam;
    const facturaIndex = Array.isArray(facturaIndexParam) ? facturaIndexParam[0] : facturaIndexParam;
    
    const { ObjectId } = await import('mongodb');
    const collection = (database as any).getCollection('proveedores');
    
    const proveedor = await collection.findOne({ _id: new ObjectId(proveedorId) });
    if (!proveedor) {
      res.status(404).json({ error: 'Proveedor no encontrado' });
      return;
    }
    
    if (parseInt(facturaIndex) < 0) {
      const imagenTemporal = proveedor.imagenTemporal || null;
      return res.json({ imagenes: imagenTemporal ? [imagenTemporal] : [], imagenTemporal });
    }
    
    const facturas = proveedor.facturas || [];
    const factura = facturas[parseInt(facturaIndex)];
    
    if (!factura) {
      res.status(404).json({ error: 'Factura no encontrada' });
      return;
    }
    
    const imagenes = factura.imagenes || [];
    res.json({ imagenes });
  } catch (error) {
    console.error('Error getting images:', error);
    res.status(500).json({ error: 'Error al obtener imágenes' });
  }
});

app.delete('/api/facturas/imagenes/:proveedorId/:facturaIndex/:imagenIndex', async (req: Request, res: Response) => {
  try {
    const proveedorIdParam = req.params.proveedorId;
    const facturaIndexParam = req.params.facturaIndex;
    const imagenIndexParam = req.params.imagenIndex;
    const proveedorId = Array.isArray(proveedorIdParam) ? proveedorIdParam[0] : proveedorIdParam;
    const facturaIndex = Array.isArray(facturaIndexParam) ? facturaIndexParam[0] : facturaIndexParam;
    const imagenIndex = Array.isArray(imagenIndexParam) ? imagenIndexParam[0] : imagenIndexParam;
    const { ObjectId } = await import('mongodb');
    const collection = (database as any).getCollection('proveedores');
    
    const proveedor = await collection.findOne({ _id: new ObjectId(proveedorId) });
    if (!proveedor) {
      res.status(404).json({ error: 'Proveedor no encontrado' });
      return;
    }
    
    const idx = parseInt(facturaIndex);
    const imgIdx = parseInt(imagenIndex);
    
    const updateField = `facturas.${idx}.imagenes.${imgIdx}`;
    await collection.updateOne(
      { _id: new ObjectId(proveedorId) },
      { $unset: { [updateField]: 1 } }
    );
    
    await collection.updateOne(
      { _id: new ObjectId(proveedorId) },
      { $pull: { [`facturas.${idx}.imagenes`]: null } }
    );
    
    res.json({ success: true });
  } catch (error) {
    console.error('Error deleting image:', error);
    res.status(500).json({ error: 'Error al eliminar imagen' });
  }
});

app.put('/api/facturas/imagenes/:proveedorId/:facturaIndex/:imagenIndex', async (req: Request, res: Response) => {
  try {
    const proveedorIdParam = req.params.proveedorId;
    const facturaIndexParam = req.params.facturaIndex;
    const imagenIndexParam = req.params.imagenIndex;
    const proveedorId = Array.isArray(proveedorIdParam) ? proveedorIdParam[0] : proveedorIdParam;
    const facturaIndex = Array.isArray(facturaIndexParam) ? facturaIndexParam[0] : facturaIndexParam;
    const imagenIndex = Array.isArray(imagenIndexParam) ? imagenIndexParam[0] : imagenIndexParam;
    const { imagen } = req.body;
    
    const { ObjectId } = await import('mongodb');
    const collection = (database as any).getCollection('proveedores');
    
    const idx = parseInt(facturaIndex);
    const imgIdx = parseInt(imagenIndex);
    
    const updateField = `facturas.${idx}.imagenes.${imgIdx}`;
    await collection.updateOne(
      { _id: new ObjectId(proveedorId) },
      { $set: { [updateField]: imagen } }
    );
    
    res.json({ success: true });
  } catch (error) {
    console.error('Error updating image:', error);
    res.status(500).json({ error: 'Error al actualizar imagen' });
  }
});

app.get('/upload-factura/:token', async (req: Request, res: Response) => {
  const token = req.params.token as string;
  const uploadData = uploadTokens.get(token);
  
  console.log('=== UPLOAD PAGE ACCESS ===');
  console.log('Token:', token);
  console.log('Token exists:', !!uploadData);
  console.log('Expired:', uploadData ? new Date() > uploadData.expiresAt : 'N/A');
  
  if (!uploadData) {
    res.send(`
      <!DOCTYPE html>
      <html>
      <head>
        <title>Enlace expirado</title>
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <style>
          body { font-family: Arial, sans-serif; padding: 20px; text-align: center; }
          .error { color: red; }
        </style>
      </head>
      <body>
        <h1 class="error">Enlace expirado o inválido</h1>
        <p>Por favor genera un nuevo código QR desde la aplicación.</p>
      </body>
      </html>
    `);
    return;
  }
  
  if (new Date() > uploadData.expiresAt) {
    uploadTokens.delete(token);
    res.send(`
      <!DOCTYPE html>
      <html>
      <head>
        <title>Enlace expirado</title>
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <style>
          body { font-family: Arial, sans-serif; padding: 20px; text-align: center; }
          .error { color: red; }
        </style>
      </head>
      <body>
        <h1 class="error">El enlace ha expirado</h1>
        <p>Por favor genera un nuevo código QR desde la aplicación.</p>
      </body>
      </html>
    `);
    return;
  }
  
  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>Subir foto de factura</title>
      <meta name="viewport" content="width=device-width, initial-scale=1">
      <style>
        * { box-sizing: border-box; }
        body { font-family: Arial, sans-serif; padding: 20px; max-width: 500px; margin: 0 auto; }
        h1 { text-align: center; color: #333; }
        .upload-area {
          border: 2px dashed #ccc;
          border-radius: 10px;
          padding: 30px;
          text-align: center;
          margin: 20px 0;
          cursor: pointer;
        }
        .upload-area:hover { border-color: #007bff; background: #f8f9fa; }
        input[type="file"] { display: none; }
        .btn-camera {
          background: #007bff;
          color: white;
          padding: 15px 30px;
          border: none;
          border-radius: 5px;
          font-size: 16px;
          cursor: pointer;
          width: 100%;
        }
        .btn-camera:hover { background: #0056b3; }
        .preview { margin-top: 20px; }
        .preview img { max-width: 100%; border-radius: 5px; }
        .status { padding: 10px; margin: 10px 0; border-radius: 5px; }
        .status.success { background: #d4edda; color: #155724; }
        .status.error { background: #f8d7da; color: #721c24; }
        .loading { text-align: center; padding: 20px; }
        .checkbox-container {
          margin: 15px 0;
          display: flex;
          align-items: center;
          justify-content: center;
        }
        .checkbox-container input {
          width: auto;
          margin-right: 8px;
        }
        .checkbox-container label {
          font-size: 14px;
          color: #333;
        }
        .datos-extraidos {
          background: #e7f3ff;
          border: 1px solid #b3d9ff;
          border-radius: 8px;
          padding: 15px;
          margin-top: 15px;
        }
        .datos-extraidos h3 {
          margin-top: 0;
          color: #0066cc;
        }
        .datos-extraidos p {
          margin: 5px 0;
        }
        .btn-cerrar {
          margin-top: 15px;
          width: 100%;
          padding: 12px;
          background: #28a745;
          color: white;
          border: none;
          border-radius: 5px;
          font-size: 16px;
          cursor: pointer;
        }
        .btn-cerrar:hover {
          background: #218838;
        }
        .debug-info {
          background: #f0f0f0;
          padding: 10px;
          margin: 10px 0;
          font-size: 12px;
          word-break: break-all;
        }
      </style>
    </head>
    <body>
      <h1>📷 Subir Foto de Factura</h1>
      <div class="debug-info" id="debugInfo"></div>
      <script>
        document.getElementById('debugInfo').textContent = 'URL: ' + window.location.href + ' | Token: ' + (window.location.pathname.split('/upload-factura/')[1] || 'NO ENCONTRADO');
      </script>
      <div class="checkbox-container">
        <input type="checkbox" id="extraerDatos">
        <label for="extraerDatos">🤖 Extraer datos automáticamente (IA)</label>
      </div>
      <div class="upload-area" onclick="document.getElementById('fileInput').click()">
        <input type="file" id="fileInput" accept="image/*" capture="environment" onchange="handleFileSelect(event)">
        <button class="btn-camera">📸 Tomar foto o seleccionar</button>
        <p id="statusText"></p>
      </div>
      <div class="preview" id="preview"></div>
      <div class="loading" id="loading" style="display:none;">Procesando imagen y extrayendo datos...</div>
      <div id="datosExtraidos"></div>
      <div style="background:#ff0; padding:10px; margin:10px; font-size:12px;" id="debugDiv">
        Debug: Cargando... origin=<span id="debugOrigin"></span>
      </div>
      <script>
        document.getElementById('debugOrigin').textContent = window.location.origin;
        let selectedFile = null;
        const token = window.location.pathname.split('/upload-factura/')[1] || '';
        console.log('Token from URL:', token);
        
        function handleFileSelect(event) {
          selectedFile = event.target.files[0];
          console.log('Archivo seleccionado:', selectedFile?.name);
          if (selectedFile) {
            const reader = new FileReader();
            reader.onload = function(e) {
              document.getElementById('preview').innerHTML = '<img src="' + e.target.result + '" alt="Preview">';
              console.log('Reader cargado, subiendo archivo');
              uploadFile();
            };
            reader.readAsDataURL(selectedFile);
          }
        }
        
        async function uploadFile() {
          if (!selectedFile) return;
          if (!token) {
            document.getElementById('statusText').textContent = 'Error: Token no encontrado';
            return;
          }
          
          const extraerDatos = document.getElementById('extraerDatos').checked;
          
          document.getElementById('loading').style.display = 'block';
          document.getElementById('statusText').textContent = extraerDatos ? 'Procesando imagen y extrayendo datos con IA...' : 'Subiendo imagen...';
          document.getElementById('datosExtraidos').innerHTML = '';
          
          const formData = new FormData();
          formData.append('imagen', selectedFile);
          formData.append('token', token);
          formData.append('extraerDatos', extraerDatos.toString());
          
          console.log('Uploading with token:', token);
          
          try {
            const uploadUrl = '/api/facturas/upload-photo';
            console.log('Fetching:', uploadUrl, 'token:', token);
            
            document.getElementById('debugDiv').textContent = 'Debug: Subiendo a ' + uploadUrl + ' token=' + token;
            document.getElementById('statusText').textContent = 'Intentando subir...';
            
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 30000);
            
            try {
              const response = await fetch(uploadUrl, {
                method: 'POST',
                body: formData,
                signal: controller.signal
              });
              
              clearTimeout(timeoutId);
              console.log('Response status:', response.status);
              console.log('Response ok:', response.ok);
              
              const data = await response.json();
              console.log('Response data:', data);
            
              if (response.ok) {
              document.getElementById('statusText').textContent = '✅ ¡Foto subida exitosamente!';
              document.getElementById('statusText').className = 'status success';
              
              let datosHtml = '';
              if (data.datosExtraidos && Object.keys(data.datosExtraidos).length > 0) {
                datosHtml = '<div class="datos-extraidos">';
                datosHtml += '<h3>🤖 Datos Extraídos</h3>';
                
                const campos = [
                  { key: 'numero', label: 'Número' },
                  { key: 'numeroControl', label: 'Nro Control' },
                  { key: 'rif', label: 'RIF' },
                  { key: 'nombre', label: 'Proveedor' },
                  { key: 'fecha', label: 'Fecha' },
                  { key: 'fechaVencimiento', label: 'Vencimiento' },
                  { key: 'subtotal', label: 'Subtotal', isMoneda: true },
                  { key: 'descuento', label: 'Descuento', isMoneda: true },
                  { key: 'baseImponible', label: 'Base Imponible', isMoneda: true },
                  { key: 'baseExenta', label: 'Base Exenta', isMoneda: true },
                  { key: 'iva16', label: 'IVA 16%', isMoneda: true },
                  { key: 'iva12', label: 'IVA 12%', isMoneda: true },
                  { key: 'ivaGeneral', label: 'IVA 21%', isMoneda: true },
                  { key: 'iva75', label: 'IVA 75%', isMoneda: true },
                  { key: 'iva25', label: 'IVA 25%', isMoneda: true },
                  { key: 'montoIva', label: 'IVA', isMoneda: true },
                  { key: 'monto', label: 'Total', isMoneda: true },
                  { key: 'montoDollar', label: 'Total $', isMoneda: true },
                  { key: 'efectivo', label: 'Efectivo', isMoneda: true },
                  { key: 'tarjeta', label: 'Tarjeta', isMoneda: true },
                  { key: 'cambio', label: 'Cambio', isMoneda: true },
                  { key: 'diasCredito', label: 'Días Crédito' },
                  { key: 'retencion', label: 'Retención', isMoneda: true },
                  { key: 'telefono', label: 'Teléfono' },
                  { key: 'direccion', label: 'Dirección' },
                  { key: 'serie', label: 'Serie' },
                ];

                campos.forEach(campo => {
                  if (data.datosExtraidos[campo.key]) {
                    const valor = campo.isMoneda ? '$' + data.datosExtraidos[campo.key] : data.datosExtraidos[campo.key];
                    datosHtml += '<p><strong>' + campo.label + ':</strong> ' + valor + '</p>';
                  }
                });
                
                datosHtml += '</div>';
              }
              
              datosHtml += '<button onclick="window.close()" class="btn-cerrar">Cerrar</button>';
              document.getElementById('datosExtraidos').innerHTML = datosHtml;
              
              setTimeout(() => {
                window.close();
              }, 5000);
            } else {
              document.getElementById('statusText').textContent = '❌ Error: ' + (data.error || 'Error al subir');
              document.getElementById('statusText').className = 'status error';
            }
            } catch (error) {
              console.error('Upload error:', error);
              const errorMsg = error instanceof Error ? error.message : JSON.stringify(error);
              document.getElementById('statusText').textContent = '❌ Error: ' + errorMsg + ' (url: ' + uploadUrl + ')';
              document.getElementById('statusText').className = 'status error';
            }
          }
          
          document.getElementById('loading').style.display = 'none';
        }
      </script>
    </body>
    </html>
  `);
});

function comprimirImagenBase64(base64String: string, maxWidth: number = 800, quality: number = 0.6): string {
  return base64String;
}

function extraerDatosFactura(texto: string): any {
  const datos: any = {};
  
  const numeroMatch = texto.match(/(?:N[°o]|#|Factura|factura|N)[.:\s]*([A-Z0-9\-]+)/i);
  if (numeroMatch) datos.numero = numeroMatch[1].trim();
  
  const controlMatch = texto.match(/(?:N[°o]?\s*Control|Control)[.:\s]*([\d\-]+)/i);
  if (controlMatch) datos.numeroControl = controlMatch[1].trim();
  
  const fechaMatch = texto.match(/(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})/);
  if (fechaMatch) {
    const dia = fechaMatch[1].padStart(2, '0');
    const mes = fechaMatch[2].padStart(2, '0');
    const anio = fechaMatch[3].length === 2 ? `20${fechaMatch[3]}` : fechaMatch[3];
    datos.fecha = `${anio}-${mes}-${dia}`;
  }
  
  const fechaVencMatch = texto.match(/(?:Vence?|Vencimiento|Fecha\s*vto)[.:\s]*(\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4})/i);
  if (fechaVencMatch) datos.fechaVencimiento = fechaVencMatch[1];
  
  const rifMatch = texto.match(/(?:RIF|R\.I\.F\.)[.:\s]*([JGVEP]\-?\d{6,9}[A-Z]?)/i);
  if (rifMatch) datos.rif = rifMatch[1].toUpperCase().replace(/\s/g, '');
  
  const nombreMatch = texto.match(/(?:Proveedor|Cliente|Raz[óo]n\s*Social|Establecimiento)[.:\s]*([^\n]{3,50})/i);
  if (nombreMatch) datos.nombre = nombreMatch[1].trim();
  
  const telefonoMatch = texto.match(/(?:Tel|Teléfono|Fono)[.:\s]*([\d\-\+\(\)]{7,20})/i);
  if (telefonoMatch) datos.telefono = telefonoMatch[1].trim();
  
  const direccionMatch = texto.match(/(?:Dir|Direcci[óo]n|Address)[.:\s]*([^\n]{10,100})/i);
  if (direccionMatch) datos.direccion = direccionMatch[1].trim();
  
  const subtotalMatch = texto.match(/(?:Subtotal|Sub\s*Total|Brut[oa])[$€£]?\s*:?\s*[\$€£]?\s*([\d.,]+)/i);
  if (subtotalMatch) datos.subtotal = parseFloat(subtotalMatch[1].replace(/,/g, '.'));
  
  const descuentoMatch = texto.match(/(?:Descuento|Desc|Discount)[$€£]?\s*:?\s*[\$€£]?\s*([\d.,]+)/i);
  if (descuentoMatch) datos.descuento = parseFloat(descuentoMatch[1].replace(/,/g, '.'));
  
  const baseImponibleMatch = texto.match(/(?:Base\s*Imponible|Base\s*Tributable|Gravable)[$€£]?\s*:?\s*[\$€£]?\s*([\d.,]+)/i);
  if (baseImponibleMatch) datos.baseImponible = parseFloat(baseImponibleMatch[1].replace(/,/g, '.'));
  
  const montoMatch = texto.match(/(?:Total\s*(?:a\s*)?Pagar|Total\s*General|Total\s*Factura|Importe\s*Total|Grand\s*Total)[$€£]?\s*:?\s*[\$€£]?\s*([\d.,]+)/i);
  if (montoMatch) datos.monto = parseFloat(montoMatch[1].replace(/,/g, '.'));
  
  const montoDollarMatch = texto.match(/(?:Total\s*\$|Total\s*US\$|Total\s*USD)[.\s:]*([\d.,]+)/i);
  if (montoDollarMatch) datos.montoDollar = parseFloat(montoDollarMatch[1].replace(/,/g, '.'));
  
  const iva16Match = texto.match(/(?:IVA\s*16%|IVA\s*16|IVA\s*reduci[td]o)[$€£]?\s*:?\s*[\$€£]?\s*([\d.,]+)/i);
  if (iva16Match) datos.iva16 = parseFloat(iva16Match[1].replace(/,/g, '.'));
  
  const iva12Match = texto.match(/(?:IVA\s*12%|IVA\s*12)[$€£]?\s*:?\s*[\$€£]?\s*([\d.,]+)/i);
  if (iva12Match) datos.iva12 = parseFloat(iva12Match[1].replace(/,/g, '.'));
  
  const ivaGeneralMatch = texto.match(/(?:IVA\s*(?:general)?\s*21%|IVA\s*21|IVA\s*general)[$€£]?\s*:?\s*[\$€£]?\s*([\d.,]+)/i);
  if (ivaGeneralMatch) datos.ivaGeneral = parseFloat(ivaGeneralMatch[1].replace(/,/g, '.'));
  
  const ivaMatch = texto.match(/(?:IVA|Impuesto|TAX)[$€£]?\s*:?\s*[\$€£]?\s*([\d.,]+)/i);
  if (ivaMatch) datos.montoIva = parseFloat(ivaMatch[1].replace(/,/g, '.'));
  
  const exentoMatch = texto.match(/(?:Exento|Exenta|Base\s*Exenta|Base\s*0%)[$€£]?\s*:?\s*[\$€£]?\s*([\d.,]+)/i);
  if (exentoMatch) datos.baseExenta = parseFloat(exentoMatch[1].replace(/,/g, '.'));
  
  const iva75Match = texto.match(/(?:IVA\s*75%|IVA\s*Reduci[td]o\s*75%)[$€£]?\s*:?\s*[\$€£]?\s*([\d.,]+)/i);
  if (iva75Match) datos.iva75 = parseFloat(iva75Match[1].replace(/,/g, '.'));
  
  const iva25Match = texto.match(/(?:IVA\s*25%|IVA\s*Adicional\s*25%)[$€£]?\s*:?\s*[\$€£]?\s*([\d.,]+)/i);
  if (iva25Match) datos.iva25 = parseFloat(iva25Match[1].replace(/,/g, '.'));
  
  const retencionMatch = texto.match(/(?:Retenci[óo]n|ISR|Ret)[$€£]?\s*:?\s*[\$€£]?\s*([\d.,]+)/i);
  if (retencionMatch) datos.retencion = parseFloat(retencionMatch[1].replace(/,/g, '.'));
  
  const creditoMatch = texto.match(/(?:D[íoa]s?\s*cr[éo]dito|Cr[éo]dito\s*(?:a|a\s*)?\s*(\d+)\s*d[íoa]s)/i);
  if (creditoMatch) datos.diasCredito = parseInt(creditoMatch[1]);
  
  const efectivoMatch = texto.match(/(?:Efectivo|Paid\s*Cash|Cash)[$€£]?\s*:?\s*[\$€£]?\s*([\d.,]+)/i);
  if (efectivoMatch) datos.efectivo = parseFloat(efectivoMatch[1].replace(/,/g, '.'));
  
  const cambioMatch = texto.match(/(?:Cambio|Change|Vuelto)[$€£]?\s*:?\s*[\$€£]?\s*([\d.,]+)/i);
  if (cambioMatch) datos.cambio = parseFloat(cambioMatch[1].replace(/,/g, '.'));
  
  const tarjetaMatch = texto.match(/(?:Tarjeta|D[éo]bito|Cr[éo]dito\s*(?:card)?)[$€£]?\s*:?\s*[\$€£]?\s*([\d.,]+)/i);
  if (tarjetaMatch) datos.tarjeta = parseFloat(tarjetaMatch[1].replace(/,/g, '.'));
  
  const serieMatch = texto.match(/(?:Serie|S\/N|SN)[.:\s]*([A-Z0-9\-]+)/i);
  if (serieMatch) datos.serie = serieMatch[1].trim();
  
  return datos;
}

app.get('/api/facturas/debug-upload-tokens', (req, res) => {
  const tokens: any[] = [];
  uploadTokens.forEach((value, key) => {
    tokens.push({ token: key, expiresAt: value.expiresAt, proveedorId: value.proveedorId, facturaIndex: value.facturaIndex });
  });
  res.json({ count: tokens.length, tokens });
});

app.post('/api/facturas/upload-photo', multer().any(), async (req: Request, res: Response) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  
  console.log('=== UPLOAD PHOTO DEBUG ===');
  console.log('Body keys:', Object.keys(req.body || {}));
  console.log('Body:', JSON.stringify(req.body).substring(0, 500));
  console.log('Files:', req.files);
  console.log('Headers:', req.headers['content-type']);
  
  if (!req.body || Object.keys(req.body).length === 0) {
    console.log('WARNING: Empty body - checking if form-data parsing failed');
  }
  
  try {
    const token = req.body?.token as string;
    const files = req.files as any[];
    const file = files?.[0];
    const imagen = req.body?.imagen;
    const extraerDatos = req.body?.extraerDatos === 'true';
    
    const uploadData = uploadTokens.get(token);
    
    if (!uploadData) {
      res.status(400).json({ error: 'Token inválido o expirado' });
      return;
    }
    
    if (new Date() > uploadData.expiresAt) {
      uploadTokens.delete(token);
      res.status(400).json({ error: 'Token expirado' });
      return;
    }
    
    let imagenBase64 = imagen;
    if (file) {
      imagenBase64 = `data:${file.mimetype};base64,${file.buffer.toString('base64')}`;
    }
    
    let datosExtraidos = null;
    if (extraerDatos && imagenBase64) {
      try {
        const result = await Tesseract.recognize(imagenBase64, 'spa+eng', {
          logger: m => console.log('OCR:', m)
        });
        const texto = result.data.text;
        console.log('===== TEXTO OCR COMPLETO =====');
        console.log(texto);
        console.log('===== FIN TEXTO OCR =====');
        datosExtraidos = extraerDatosFactura(texto);
        console.log('===== DATOS EXTRAIDOS COMPLETOS =====');
        console.log(JSON.stringify(datosExtraidos, null, 2));
        console.log('===== FIN DATOS EXTRAIDOS =====');
      } catch (ocrError) {
        console.error('Error en OCR:', ocrError);
      }
    }
    
    const { ObjectId } = await import('mongodb');
    const collection = (database as any).getCollection('proveedores');
    
    if (uploadData.facturaIndex >= 0) {
      const pushData: any = {};
      pushData[`facturas.${uploadData.facturaIndex}.imagenes`] = { $each: [imagenBase64] };
      
      await collection.updateOne(
        { _id: new ObjectId(uploadData.proveedorId) },
        { $push: pushData }
      );
      
      if (datosExtraidos) {
        const setData: any = {};
        setData[`facturas.${uploadData.facturaIndex}.datosExtraidos`] = datosExtraidos;
        if (datosExtraidos.numero) setData[`facturas.${uploadData.facturaIndex}.numero`] = datosExtraidos.numero;
        if (datosExtraidos.fecha) setData[`facturas.${uploadData.facturaIndex}.fecha`] = new Date(datosExtraidos.fecha);
        if (datosExtraidos.monto) setData[`facturas.${uploadData.facturaIndex}.monto`] = datosExtraidos.monto;
        if (datosExtraidos.montoDollar) setData[`facturas.${uploadData.facturaIndex}.monto`] = datosExtraidos.montoDollar;
        if (datosExtraidos.baseImponible) setData[`facturas.${uploadData.facturaIndex}.baseImponible`] = datosExtraidos.baseImponible;
        if (datosExtraidos.baseExenta) setData[`facturas.${uploadData.facturaIndex}.baseExenta`] = datosExtraidos.baseExenta;
        if (datosExtraidos.montoIva) setData[`facturas.${uploadData.facturaIndex}.montoIva`] = datosExtraidos.montoIva;
        if (datosExtraidos.iva75) setData[`facturas.${uploadData.facturaIndex}.iva75`] = datosExtraidos.iva75;
        if (datosExtraidos.iva25) setData[`facturas.${uploadData.facturaIndex}.iva25`] = datosExtraidos.iva25;
        if (datosExtraidos.iva16) setData[`facturas.${uploadData.facturaIndex}.iva16`] = datosExtraidos.iva16;
        if (datosExtraidos.subtotal) setData[`facturas.${uploadData.facturaIndex}.subtotal`] = datosExtraidos.subtotal;
        if (datosExtraidos.descuento) setData[`facturas.${uploadData.facturaIndex}.descuento`] = datosExtraidos.descuento;
        
        await collection.updateOne(
          { _id: new ObjectId(uploadData.proveedorId) },
          { $set: setData }
        );
      }
    } else {
      const setData: any = { imagenTemporal: imagenBase64 };
      if (datosExtraidos) {
        setData.datosExtraidos = datosExtraidos;
      }
      await collection.updateOne(
        { _id: new ObjectId(uploadData.proveedorId) },
        { $set: setData }
      );
    }
    
    uploadTokens.delete(token);
    
    res.json({ 
      success: true, 
      message: 'Foto guardada exitosamente',
      datosExtraidos: datosExtraidos
    });
  } catch (error) {
    console.error('Error uploading photo:', error);
    res.status(500).json({ error: 'Error al guardar la foto' });
  }
});

app.post('/api/facturas/save-temp-image', async (req: Request, res: Response) => {
  try {
    const { proveedorId, facturaIndex } = req.body;
    
    if (!proveedorId || facturaIndex === undefined) {
      return res.status(400).json({ error: 'Faltan datos requeridos' });
    }
    
    const { ObjectId } = await import('mongodb');
    const collection = (database as any).getCollection('proveedores');
    
    const proveedor = await collection.findOne({ _id: new ObjectId(proveedorId) });
    if (!proveedor) {
      return res.status(404).json({ error: 'Proveedor no encontrado' });
    }
    
    const imagenTemporal = proveedor.imagenTemporal;
    if (!imagenTemporal) {
      return res.json({ success: true, message: 'No hay imagen temporal' });
    }
    
    await collection.updateOne(
      { _id: new ObjectId(proveedorId) },
      { 
        $push: { [`facturas.${facturaIndex}.imagenes`]: imagenTemporal },
        $unset: { imagenTemporal: '', datosExtraidos: '' }
      }
    );
    
    res.json({ success: true });
  } catch (error) {
    console.error('Error saving temp image:', error);
    res.status(500).json({ error: 'Error al guardar imagen temporal' });
  }
});

// ============ MANUALES API (Paso a Paso) ============

const getManualId = (idParam: string | string[]): string => {
  return Array.isArray(idParam) ? idParam[0] : idParam;
};

// GET all manuales
app.get('/api/manuales', async (req: Request, res: Response) => {
  try {
    const collection = database.getCollection('manuales');
    const manuales = await collection.find().sort({ fechaCreacion: -1 }).toArray();
    
    const manualesFormatted = manuales.map((m: any) => ({
      id: m._id.toString(),
      titulo: m.titulo,
      descripcion: m.descripcion,
      categoria: m.categoria,
      pasos: m.pasos || [],
      fechaCreacion: m.fechaCreacion,
      fechaActualizacion: m.fechaActualizacion
    }));
    
    res.json(manualesFormatted);
  } catch (error) {
    console.error('Error getting manuales:', error);
    res.status(500).json({ error: 'Error al obtener manuales' });
  }
});

// GET single manual
app.get('/api/manuales/:id', async (req: Request, res: Response) => {
  try {
    const { ObjectId } = await import('mongodb');
    const collection = database.getCollection('manuales');
    const id = getManualId(req.params.id);
    const manual = await collection.findOne({ _id: new ObjectId(id) });
    
    if (!manual) {
      return res.status(404).json({ error: 'Manual no encontrado' });
    }
    
    res.json({
      id: manual._id.toString(),
      titulo: manual.titulo,
      descripcion: manual.descripcion,
      categoria: manual.categoria,
      pasos: manual.pasos || [],
      fechaCreacion: manual.fechaCreacion,
      fechaActualizacion: manual.fechaActualizacion
    });
  } catch (error) {
    console.error('Error getting manual:', error);
    res.status(500).json({ error: 'Error al obtener manual' });
  }
});

// POST create manual
app.post('/api/manuales', authenticateToken, async (req: Request, res: Response) => {
  try {
    const user = req.user as any;
    if (user.rol !== 'root') {
      return res.status(403).json({ error: 'Solo el usuario root puede crear manuales' });
    }
    
    const { titulo, descripcion, categoria, pasos } = req.body;
    
    if (!titulo || !titulo.trim()) {
      return res.status(400).json({ error: 'El título es requerido' });
    }
    
    if (!pasos || !Array.isArray(pasos) || pasos.length === 0) {
      return res.status(400).json({ error: 'Debe agregar al menos un paso' });
    }
    
    // Validate steps
    for (let i = 0; i < pasos.length; i++) {
      if (!pasos[i].titulo || !pasos[i].titulo.trim()) {
        return res.status(400).json({ error: `El paso ${i + 1} debe tener un título` });
      }
      if (!pasos[i].descripcion || !pasos[i].descripcion.trim()) {
        return res.status(400).json({ error: `El paso ${i + 1} debe tener una descripción` });
      }
    }
    
    const manual = {
      titulo: titulo.trim(),
      descripcion: descripcion?.trim() || '',
      categoria: categoria || 'general',
      pasos: pasos.map((p: any, index: number) => ({
        id: p.id || `${Date.now()}-${index}`,
        numero: index + 1,
        titulo: p.titulo.trim(),
        descripcion: p.descripcion.trim(),
        imagen: p.imagen || ''
      })),
      fechaCreacion: new Date(),
      creadoPor: user.username
    };
    
    const collection = database.getCollection('manuales');
    const result = await collection.insertOne(manual);
    
    res.json({ 
      success: true, 
      id: result.insertedId.toString()
    });
  } catch (error) {
    console.error('Error creating manual:', error);
    res.status(500).json({ error: 'Error al crear manual' });
  }
});

// PUT update manual
app.put('/api/manuales/:id', authenticateToken, async (req: Request, res: Response) => {
  try {
    const user = req.user as any;
    if (user.rol !== 'root') {
      return res.status(403).json({ error: 'Solo el usuario root puede editar manuales' });
    }
    
    const { ObjectId } = await import('mongodb');
    const collection = database.getCollection('manuales');
    const id = getManualId(req.params.id);
    
    const { titulo, descripcion, categoria, pasos } = req.body;
    
    if (!titulo || !titulo.trim()) {
      return res.status(400).json({ error: 'El título es requerido' });
    }
    
    if (!pasos || !Array.isArray(pasos) || pasos.length === 0) {
      return res.status(400).json({ error: 'Debe agregar al menos un paso' });
    }
    
    const updateData = {
      titulo: titulo.trim(),
      descripcion: descripcion?.trim() || '',
      categoria: categoria || 'general',
      pasos: pasos.map((p: any, index: number) => ({
        id: p.id || `${Date.now()}-${index}`,
        numero: index + 1,
        titulo: p.titulo.trim(),
        descripcion: p.descripcion.trim(),
        imagen: p.imagen || ''
      })),
      fechaActualizacion: new Date()
    };
    
    await collection.updateOne(
      { _id: new ObjectId(id) },
      { $set: updateData }
    );
    
    res.json({ success: true });
  } catch (error) {
    console.error('Error updating manual:', error);
    res.status(500).json({ error: 'Error al actualizar manual' });
  }
});

// DELETE manual
app.delete('/api/manuales/:id', authenticateToken, async (req: Request, res: Response) => {
  try {
    const user = req.user as any;
    if (user.rol !== 'root') {
      return res.status(403).json({ error: 'Solo el usuario root puede eliminar manuales' });
    }
    
    const { ObjectId } = await import('mongodb');
    const collection = database.getCollection('manuales');
    const id = getManualId(req.params.id);
    
    await collection.deleteOne({ _id: new ObjectId(id) });
    
    res.json({ success: true });
  } catch (error) {
    console.error('Error deleting manual:', error);
    res.status(500).json({ error: 'Error al eliminar manual' });
  }
});

// ============ API RETENCIONES ============

const retencionesSettings = {
  ultimoNumero: 0
};

app.get('/api/retenciones', async (req: Request, res: Response) => {
  try {
    const collection = database.getCollection('retenciones');
    const resultados = await collection.find().sort({ numero: -1 }).toArray();
    res.json(resultados);
  } catch (error) {
    console.error('Error obteniendo retenciones:', error);
    res.status(500).json({ error: 'Error al obtener retenciones' });
  }
});

app.post('/api/retenciones', async (req: Request, res: Response) => {
  try {
    const { numero, proveedorRif, proveedorNombre, facturaNumero, facturaFecha, fechaPagada, numeroControl, totalCompras, baseImponible, montoBsf, exento, exentoBsf, porcentajeIva, iva, retenido } = req.body;
    
    const collection = database.getCollection('retenciones');
    
    const existente = await collection.findOne({ facturaNumero: facturaNumero, proveedorRif: proveedorRif });
    if (existente) {
      res.status(400).json({ error: 'Ya existe una retención para esta factura' });
      return;
    }
    
    const retencion = {
      numero,
      proveedorRif,
      proveedorNombre,
      facturaNumero,
      facturaFecha: new Date(facturaFecha),
      fechaPagada: fechaPagada ? new Date(fechaPagada) : new Date(),
      numeroControl: numeroControl || '',
      totalCompras,
      baseImponible,
      montoBsf: montoBsf || totalCompras,
      exento,
      exentoBsf: exentoBsf || 0,
      porcentajeIva,
      iva,
      retenido,
      creadoEn: new Date()
    };
    
    const result = await collection.insertOne(retencion);
    
    if (parseInt(numero) > retencionesSettings.ultimoNumero) {
      const secuencia = parseInt(numero.slice(-8));
      retencionesSettings.ultimoNumero = secuencia;
    }
    
    res.json({ success: true, _id: result.insertedId, retencion });
  } catch (error) {
    console.error('Error guardando retencion:', error);
    res.status(500).json({ error: 'Error al guardar retencion' });
  }
});

app.get('/api/retenciones/ultimo', (req: Request, res: Response) => {
  res.json({ ultimoNumero: retencionesSettings.ultimoNumero });
});

app.put('/api/retenciones/ultimo', (req: Request, res: Response) => {
  const { ultimoNumero } = req.body;
  if (typeof ultimoNumero === 'number' && ultimoNumero >= 0) {
    retencionesSettings.ultimoNumero = ultimoNumero;
    res.json({ success: true, ultimoNumero: retencionesSettings.ultimoNumero });
  } else {
    res.status(400).json({ error: 'Número inválido' });
  }
});

app.delete('/api/retenciones/:id', async (req: Request, res: Response) => {
  try {
    const { ObjectId } = await import('mongodb');
    const idParam = req.params.id;
    const id = Array.isArray(idParam) ? idParam[0] : idParam;
    
    const collection = database.getCollection('retenciones');
    const result = await collection.deleteOne({ _id: new ObjectId(id) });
    
    if (result.deletedCount === 0) {
      res.status(404).json({ error: 'Retención no encontrada' });
      return;
    }
    
    res.json({ success: true });
  } catch (error) {
    console.error('Error eliminando retención:', error);
    res.status(500).json({ error: 'Error al eliminar retención' });
  }
});

app.use((req: Request, res: Response) => {
  res.status(404).json({ error: 'Ruta no encontrada' });
});

async function startServer() {
  const dbConnected = await database.connect();

  app.listen(PORT, () => {
    if (dbConnected) {
      console.log(`Servidor ejecutándose en http://localhost:${PORT}`);
      console.log(`Swagger UI disponible en http://localhost:${PORT}/api-docs`);
    } else {
      console.log(`Servidor ejecutándose en http://localhost:${PORT} (sin MongoDB)`);
      console.log(`Swagger UI disponible en http://localhost:${PORT}/api-docs`);
      console.log('ADVERTENCIA: MongoDB no conectado - algunas funciones pueden no funcionar');
    }
  });
}

startServer();

export default app;
