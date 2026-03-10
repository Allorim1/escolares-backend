import express, { Express, Request, Response } from 'express';
import cors from 'cors';
import swaggerJsdoc from 'swagger-jsdoc';
import swaggerUi from 'swagger-ui-express';
import cookieParser from 'cookie-parser';
import { database } from './config/database';
import { swaggerConfig } from './config/swagger';

import marcasRoutes from './routes/marcas.routes';
import lineasRoutes from './routes/lineas.routes';
import ofertasRoutes from './routes/ofertas.routes';
import authRoutes from './routes/auth.routes';

const app: Express = express();
const PORT = process.env.PORT || 3000;

const swaggerSpec = swaggerJsdoc(swaggerConfig);

const corsOptions = {
  origin: function (
    origin: string | undefined,
    callback: (err: Error | null, allow?: boolean) => void,
  ) {
    callback(null, true);
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'x-dolarvzla-key'],
};

app.use(cors(corsOptions));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ limit: '10mb', extended: true }));
app.use(cookieParser());

const DOLAR_API_KEY = '43dd3cbe6c7e05cc994e3c98aefa0eb84c5c36ab4d615a3dc7c24d85d76afe0f';
const DOLAR_API_URL = 'https://api.dolarvzla.com/public/bcv/exchange-rate';
const USDT_API_URL = 'https://api.dolarvzla.com/public/usdt/exchange-rate';

app.get('/api/tasas', async (req: Request, res: Response) => {
  try {
    const [bcvRes, usdtRes] = await Promise.all([
      fetch(DOLAR_API_URL, {
        headers: {
          'x-dolarvzla-key': DOLAR_API_KEY,
        },
      }),
      fetch(USDT_API_URL, {
        headers: {
          'x-dolarvzla-key': DOLAR_API_KEY,
        },
      }),
    ]);

    const bcvData: any = bcvRes.ok ? await bcvRes.json() : null;
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

    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET');
    res.header('Access-Control-Allow-Headers', 'Content-Type');
    res.json(result);
  } catch (error) {
    console.error('Error fetching tasas:', error);
    res.status(500).json({ error: 'Internal server error' });
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

app.use('/api/marcas', marcasRoutes);
app.use('/api/lineas', lineasRoutes);
app.use('/api/ofertas', ofertasRoutes);
app.use('/api/auth', authRoutes);

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
