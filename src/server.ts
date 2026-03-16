import express, { Express, Request, Response } from 'express';
import cors from 'cors';
import swaggerJsdoc from 'swagger-jsdoc';
import swaggerUi from 'swagger-ui-express';
import cookieParser from 'cookie-parser';
import { database } from './config/database';
import { swaggerConfig } from './config/swagger';
import { authenticateToken } from './middlewares/auth.middleware';
import QRCode from 'qrcode';
import { randomBytes } from 'crypto';
import multer from 'multer';
import Tesseract from 'tesseract.js';

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

const DOLAR_API_KEY = 'bbbd54363b1dd358ef88e852f45273054a48d95626fecab50090e3cae19214e1';
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
    const proveedores = await collection.find().sort({ nombre: 1 }).toArray();
    res.json(proveedores);
  } catch (error: any) {
    console.error('Error obteniendo proveedores:', error);
    res.status(500).json({ error: 'Error al obtener proveedores', details: error.message });
  }
});

app.post('/api/proveedores', authenticateToken, async (req: Request, res: Response) => {
  try {
    const { nombre, rif, direccion, correo, telefono, vendedor, cuentasBancarias } = req.body;
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
      rif: rif || '',
      direccion: direccion || '',
      correo: correo || '',
      telefono: telefono || '',
      vendedor: vendedor || '',
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
    const { nombre, rif, direccion, correo, telefono, vendedor, cuentasBancarias } = req.body;
    const usuario = (req as any).user?.nombre || (req as any).user?.username || (req as any).user?.email || 'Sistema';
    const idParam = req.params.id;
    const id = Array.isArray(idParam) ? idParam[0] : idParam;
    const collection = (database as any).getCollection('proveedores');
    
    const proveedorActual = await collection.findOne({ _id: new ObjectId(id) });
    
    const modificaciones: { campo: string; valorAnterior: string; valorNuevo: string; fecha: Date; usuario: string }[] = [];
    
    const campos = ['nombre', 'rif', 'direccion', 'correo', 'telefono', 'vendedor', 'cuentasBancarias'];
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
    
    const updateData: any = { nombre, rif, direccion, correo, telefono, vendedor, cuentasBancarias, modificadoPor: usuario, fechaModificacion: new Date() };
    
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
    const { numero, fecha, tipo, monto, montoIva, baseImponible, baseExenta, porcentajeIva } = req.body;
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
      totalPagar = monto + baseEx + iva;
      deudaActual = monto + baseEx;
      deudaIva = iva75;
      deudaIva25 = iva25;
    }
    
    const factura = {
      numero,
      tipo: tipoDoc,
      monto: monto || 0,
      montoIva: montoIva || 0,
      fecha: fecha ? new Date(fecha) : new Date(),
      baseImponible: baseImpo,
      baseExenta: baseEx,
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
    };
    
    const collection = (database as any).getCollection('proveedores');
    await collection.updateOne(
      { _id: new ObjectId(id) },
      { $push: { facturas: factura } }
    );
    res.json({ success: true });
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
    
    const { numero, fecha, tipo, monto, montoIva, baseImponible, baseExenta, abonos, totalPagar } = req.body;
    
    const collection = (database as any).getCollection('proveedores');
    const proveedor = await collection.findOne({ _id: new ObjectId(id) });
    
    if (!proveedor || !proveedor.facturas || index < 0 || index >= proveedor.facturas.length) {
      res.status(404).json({ error: 'Factura no encontrada' });
      return;
    }
    
    const factura = proveedor.facturas[index];
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
      nuevoTotalPagar = montoFact + baseExentaFact + montoIvaFact;
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
    const deudaActual = factura.totalPagar - nuevoAbono;
    
    const abonosArray = factura.abonosArray || [];
    const fechaAbonoDate = fechaAbono ? new Date(fechaAbono + 'T00:00:00') : new Date();
    
    abonosArray.push({
      monto: montoNum,
      fecha: fechaAbonoDate,
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
    console.error('Error agregando abono:', error);
    res.status(500).json({ error: 'Error al agregar abono', details: error.message });
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
      res.status(400).json({ error: 'Monto de abono inválido' });
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
    const abonoIvaActual = factura.abonosIva || 0;
    const nuevoAbonoIva = abonoIvaActual + montoNum;
    const deudaIva = (factura.iva75 || 0) - nuevoAbonoIva;
    
    proveedor.facturas[index] = {
      ...factura,
      abonosIva: nuevoAbonoIva,
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
})

app.use('/api/marcas', marcasRoutes);
app.use('/api/lineas', lineasRoutes);
app.use('/api/ofertas', ofertasRoutes);
app.use('/api/auth', authRoutes);

const uploadTokens = new Map<string, { proveedorId: string; facturaIndex: number; expiresAt: Date }>();

app.post('/api/facturas/generate-qr', authenticateToken, async (req: Request, res: Response) => {
  try {
    const { proveedorId, facturaIndex } = req.body;
    const token = randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000);
    
    uploadTokens.set(token, { proveedorId, facturaIndex, expiresAt });
    
    const host = req.get('host');
    const isLocalhost = host?.includes('localhost') || host?.includes('127.0.0.1');
    const baseUrl = process.env.BASE_URL || (isLocalhost ? `http://${host}` : `https://${host}`);
    const uploadUrl = `${baseUrl}/upload-factura/${token}`;
    
    const qrDataUrl = await QRCode.toDataURL(uploadUrl, {
      width: 300,
      margin: 2,
    });
    
    res.json({ qrCode: qrDataUrl, uploadUrl, expiresAt: expiresAt.toISOString() });
  } catch (error) {
    console.error('Error generating QR:', error);
    res.status(500).json({ error: 'Error al generar código QR' });
  }
});

app.get('/upload-factura/:token', async (req: Request, res: Response) => {
  const token = req.params.token as string;
  const uploadData = uploadTokens.get(token);
  
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
      </style>
    </head>
    <body>
      <h1>📷 Subir Foto de Factura</h1>
      <div class="checkbox-container">
        <input type="checkbox" id="extraerDatos" checked>
        <label for="extraerDatos">🤖 Extraer datos automáticamente</label>
      </div>
      <div class="upload-area" onclick="document.getElementById('fileInput').click()">
        <input type="file" id="fileInput" accept="image/*" capture="environment" onchange="handleFileSelect(event)">
        <button class="btn-camera">📸 Tomar foto o seleccionar</button>
        <p id="statusText"></p>
      </div>
      <div class="preview" id="preview"></div>
      <div class="loading" id="loading" style="display:none;">Procesando imagen y extrayendo datos...</div>
      <div id="datosExtraidos"></div>
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
          
          const extraerDatos = document.getElementById('extraerDatos').checked;
          
          document.getElementById('loading').style.display = 'block';
          document.getElementById('statusText').textContent = extraerDatos ? 'Procesando imagen y extrayendo datos con IA...' : 'Subiendo imagen...';
          document.getElementById('datosExtraidos').innerHTML = '';
          
          const formData = new FormData();
          formData.append('imagen', selectedFile);
          formData.append('token', '${token}');
          formData.append('extraerDatos', extraerDatos.toString());
          
          try {
            const response = await fetch('/api/facturas/upload-photo', {
              method: 'POST',
              body: formData
            });
            
            const data = await response.json();
            
            if (response.ok) {
              document.getElementById('statusText').textContent = '✅ ¡Foto subida exitosamente!';
              document.getElementById('statusText').className = 'status success';
              
              if (data.datosExtraidos && Object.keys(data.datosExtraidos).length > 0) {
                let datosHtml = '<div class="datos-extraidos">';
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
                document.getElementById('datosExtraidos').innerHTML = datosHtml;
              }
            } else {
              document.getElementById('statusText').textContent = '❌ Error: ' + (data.error || 'Error al subir');
              document.getElementById('statusText').className = 'status error';
            }
          } catch (error) {
            document.getElementById('statusText').textContent = '❌ Error de conexión';
            document.getElementById('statusText').className = 'status error';
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
  console.log('Texto OCR:', texto.substring(0, 500));
  
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
  
  console.log('Datos extraídos:', datos);
  return datos;
}

app.post('/api/facturas/upload-photo', multer().any(), async (req: Request, res: Response) => {
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
        datosExtraidos = extraerDatosFactura(texto);
        console.log('Datos extraídos:', datosExtraidos);
      } catch (ocrError) {
        console.error('Error en OCR:', ocrError);
      }
    }
    
    const { ObjectId } = await import('mongodb');
    const collection = (database as any).getCollection('proveedores');
    
    const updateData: any = {};
    if (uploadData.facturaIndex >= 0) {
      updateData[`facturas.${uploadData.facturaIndex}.imagen`] = imagenBase64;
      if (datosExtraidos) {
        updateData[`facturas.${uploadData.facturaIndex}.datosExtraidos`] = datosExtraidos;
        if (datosExtraidos.numero) updateData[`facturas.${uploadData.facturaIndex}.numero`] = datosExtraidos.numero;
        if (datosExtraidos.fecha) updateData[`facturas.${uploadData.facturaIndex}.fecha`] = new Date(datosExtraidos.fecha);
        if (datosExtraidos.monto) updateData[`facturas.${uploadData.facturaIndex}.monto`] = datosExtraidos.monto;
        if (datosExtraidos.montoDollar) updateData[`facturas.${uploadData.facturaIndex}.monto`] = datosExtraidos.montoDollar;
        if (datosExtraidos.baseImponible) updateData[`facturas.${uploadData.facturaIndex}.baseImponible`] = datosExtraidos.baseImponible;
        if (datosExtraidos.baseExenta) updateData[`facturas.${uploadData.facturaIndex}.baseExenta`] = datosExtraidos.baseExenta;
        if (datosExtraidos.montoIva) updateData[`facturas.${uploadData.facturaIndex}.montoIva`] = datosExtraidos.montoIva;
        if (datosExtraidos.iva75) updateData[`facturas.${uploadData.facturaIndex}.iva75`] = datosExtraidos.iva75;
        if (datosExtraidos.iva25) updateData[`facturas.${uploadData.facturaIndex}.iva25`] = datosExtraidos.iva25;
        if (datosExtraidos.iva16) updateData[`facturas.${uploadData.facturaIndex}.iva16`] = datosExtraidos.iva16;
        if (datosExtraidos.subtotal) updateData[`facturas.${uploadData.facturaIndex}.subtotal`] = datosExtraidos.subtotal;
        if (datosExtraidos.descuento) updateData[`facturas.${uploadData.facturaIndex}.descuento`] = datosExtraidos.descuento;
      }
    } else {
      updateData.imagenTemporal = imagenBase64;
      if (datosExtraidos) {
        updateData.datosExtraidos = datosExtraidos;
      }
    }
    
    await collection.updateOne(
      { _id: new ObjectId(uploadData.proveedorId) },
      { $set: updateData }
    );
    
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
