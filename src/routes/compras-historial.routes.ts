import { Router, Request, Response } from 'express';
import { database } from '../config/database';
import { authenticateToken } from '../middlewares/auth.middleware';

const { ObjectId } = require('mongodb');

const router = Router();

const crearRegistro = async (db: any, accion: string, modulo: string, descripcion: string, datos: any, usuario: string) => {
  if (!db) return;
  const registrosCollection = db.collection('registros');
  await registrosCollection.insertOne({
    accion,
    modulo,
    descripcion,
    datos,
    usuario,
    fecha: new Date(),
  });
};

const getUsuario = (req: any) =>
  req.user?.nombre || req.user?.username || req.user?.email || 'Sistema';

router.post('/', authenticateToken, async (req: Request, res: Response) => {
  try {
    const usuario = getUsuario(req);
    const {
      proveedorId,
      proveedorNombre,
      fecha,
      numeroOrden,
      items,
      subtotal,
      totalFlete,
      totalSeguro,
      totalAduana,
      totalDescuento,
      total,
      moneda,
      estado,
      notas,
    } = req.body;

    if (!proveedorId || !proveedorNombre || !items || items.length === 0) {
      res.status(400).json({ error: 'proveedorId, proveedorNombre y items son requeridos' });
      return;
    }

    const db = database.db;
    if (!db) {
      res.status(500).json({ error: 'Base de datos no conectada' });
      return;
    }

    const compraId = new ObjectId().toString();
    const compra = {
      id: compraId,
      proveedorId,
      proveedorNombre,
      fecha: fecha ? new Date(fecha) : new Date(),
      numeroOrden,
      items,
      subtotal: subtotal || 0,
      totalFlete: totalFlete || 0,
      totalSeguro: totalSeguro || 0,
      totalAduana: totalAduana || 0,
      totalDescuento: totalDescuento || 0,
      total: total || 0,
      moneda: moneda || 'USD',
      estado: estado || 'pendiente',
      notas: notas || '',
      creadoPor: usuario,
      fechaCreacion: new Date(),
      updatedAt: new Date(),
    };

    const collection = database.getCollection('compras');
    await collection.insertOne(compra);

    await crearRegistro(db, 'Creación', 'Compras', `Compra creada para proveedor: ${proveedorNombre}`, { compraId, proveedorNombre, total, numeroOrden }, usuario);

    res.status(201).json(compra);
  } catch (error) {
    console.error('Error creando compra:', error);
    res.status(500).json({ error: 'Error al crear compra' });
  }
});

router.get('/', authenticateToken, async (req: Request, res: Response) => {
  try {
    const { proveedorId, fechaInicio, fechaFin, productoId } = req.query;
    const db = database.db;
    if (!db) {
      res.status(500).json({ error: 'Base de datos no conectada' });
      return;
    }

    const filter: any = {};

    if (proveedorId) {
      filter.proveedorId = proveedorId;
    }

    if (fechaInicio || fechaFin) {
      filter.fecha = {};
      if (fechaInicio) {
        filter.fecha.$gte = new Date(fechaInicio as string);
      }
      if ( fechaFin) {
        filter.fecha.$lte = new Date(fechaFin as string);
      }
    }

    if (productoId) {
      filter['items.productoId'] = productoId;
    }

    const compras = await database
      .getCollection('compras')
      .find(filter)
      .sort({ fecha: -1 })
      .allowDiskUse(true)
      .toArray();

    res.json(compras);
  } catch (error) {
    console.error('Error obteniendo compras:', error);
    res.status(500).json({ error: 'Error al obtener compras' });
  }
});

router.get('/:id', authenticateToken, async (req: Request, res: Response) => {
  try {
    const db = database.db;
    if (!db) {
      res.status(500).json({ error: 'Base de datos no conectada' });
      return;
    }

    const idParam = req.params.id;
    const id = Array.isArray(idParam) ? idParam[0] : idParam;

    const compra = await database.getCollection('compras').findOne({ id });

    if (!compra) {
      res.status(404).json({ error: 'Compra no encontrada' });
      return;
    }

    res.json(compra);
  } catch (error) {
    console.error('Error obteniendo compra:', error);
    res.status(500).json({ error: 'Error al obtener compra' });
  }
});

router.put('/:id', authenticateToken, async (req: Request, res: Response) => {
  try {
    const usuario = getUsuario(req);
    const db = database.db;
    if (!db) {
      res.status(500).json({ error: 'Base de datos no conectada' });
      return;
    }

    const idParam = req.params.id;
    const id = Array.isArray(idParam) ? idParam[0] : idParam;

    const {
      proveedorId,
      proveedorNombre,
      fecha,
      numeroOrden,
      items,
      subtotal,
      totalFlete,
      totalSeguro,
      totalAduana,
      totalDescuento,
      total,
      moneda,
      estado,
      notas,
    } = req.body;

    const updateData: any = {
      ...(proveedorId && { proveedorId }),
      ...(proveedorNombre && { proveedorNombre }),
      ...(fecha && { fecha: new Date(fecha) }),
      ...(numeroOrden !== undefined && { numeroOrden }),
      ...(items && { items }),
      ...(subtotal !== undefined && { subtotal }),
      ...(totalFlete !== undefined && { totalFlete }),
      ...(totalSeguro !== undefined && { totalSeguro }),
      ...(totalAduana !== undefined && { totalAduana }),
      ...(totalDescuento !== undefined && { totalDescuento }),
      ...(total !== undefined && { total }),
      ...(moneda && { moneda }),
      ...(estado && { estado }),
      ...(notas !== undefined && { notas }),
      updatedAt: new Date(),
    };

    const result = await database
      .getCollection('compras')
      .findOneAndUpdate({ id }, { $set: updateData }, { returnDocument: 'after' });

    await crearRegistro(db, 'Modificación', 'Compras', `Compra actualizada: ${id}`, { compraId: id, datos: updateData }, usuario);

    if (!result) {
      res.status(404).json({ error: 'Compra no encontrada' });
      return;
    }

    res.json(result.value);
  } catch (error) {
    console.error('Error actualizando compra:', error);
    res.status(500).json({ error: 'Error al actualizar compra' });
  }
});

router.delete('/:id', authenticateToken, async (req: Request, res: Response) => {
  try {
    const usuario = getUsuario(req);
    const db = database.db;
    if (!db) {
      res.status(500).json({ error: 'Base de datos no conectada' });
      return;
    }

    const idParam = req.params.id;
    const id = Array.isArray(idParam) ? idParam[0] : idParam;

    const compra = await database.getCollection('compras').findOne({ id });

    if (!compra) {
      res.status(404).json({ error: 'Compra no encontrada' });
      return;
    }

    await database.getCollection('compras').deleteOne({ id });

    await crearRegistro(db, 'Eliminación', 'Compras', `Compra eliminada: ${id}`, { compraId: id, proveedorNombre: compra.proveedorNombre }, usuario);

    res.json({ success: true });
  } catch (error) {
    console.error('Error eliminando compra:', error);
    res.status(500).json({ error: 'Error al eliminar compra' });
  }
});

router.get('/proveedor/:proveedorId', authenticateToken, async (req: Request, res: Response) => {
  try {
    const { proveedorId } = req.params;
    const db = database.db;
    if (!db) {
      res.status(500).json({ error: 'Base de datos no conectada' });
      return;
    }

    const compras = await database
      .getCollection('compras')
      .find({ proveedorId })
      .sort({ fecha: -1 })
      .allowDiskUse(true)
      .toArray();

    res.json(compras);
  } catch (error) {
    console.error('Error obteniendo compras por proveedor:', error);
    res.status(500).json({ error: 'Error al obtener compras por proveedor' });
  }
});

router.get('/producto/:productoId/variaciones', authenticateToken, async (req: Request, res: Response) => {
  try {
    const { productoId } = req.params;
    const db = database.db;
    if (!db) {
      res.status(500).json({ error: 'Base de datos no conectada' });
      return;
    }

    const compras = await database
      .getCollection('compras')
      .find({ 'items.productoId': productoId, estado: { $ne: 'cancelada' } })
      .sort({ fecha: 1 })
      .allowDiskUse(true)
      .toArray();

    const variaciones: any[] = [];

    for (const compra of compras) {
      for (const item of compra.items) {
        if (item.productoId === productoId) {
          const costoFlete = item.costoFlete || 0;
          const costoSeguro = item.costoSeguro || 0;
          const costoAduana = item.costoAduana || 0;
          const costoNeto = item.precioUnitario || 0;
          const costoTotalUnitario = costoNeto + costoFlete + costoSeguro + costoAduana - (item.descuentoMonto || 0);

          variaciones.push({
            fecha: compra.fecha,
            proveedorId: compra.proveedorId,
            proveedorNombre: compra.proveedorNombre,
            precioLista: item.precioUnitario,
            costoNeto,
            costoFlete,
            costoSeguro,
            costoAduana,
            costoTotalUnitario,
          });
        }
      }
    }

    res.json(variaciones);
  } catch (error) {
    console.error('Error obteniendo variaciones de precio:', error);
    res.status(500).json({ error: 'Error al obtener variaciones de precio' });
  }
});

router.get('/producto/:productoId/cpp', authenticateToken, async (req: Request, res: Response) => {
  try {
    const { productoId } = req.params;
    const db = database.db;
    if (!db) {
      res.status(500).json({ error: 'Base de datos no conectada' });
      return;
    }

    const compras = await database
      .getCollection('compras')
      .find({ 'items.productoId': productoId, estado: { $in: ['pendiente', 'recibida', 'completada'] } })
      .allowDiskUse(true)
      .toArray();

    let totalCantidadComprada = 0;
    let costoTotalAcumulado = 0;
    let productoNombre = '';

    for (const compra of compras) {
      const itemsCompra = compra.items.filter((item: any) => item.productoId === productoId);
      for (const item of itemsCompra) {
        const costoFlete = item.costoFlete || 0;
        const costoSeguro = item.costoSeguro || 0;
        const costoAduana = item.costoAduana || 0;
        const descuentoMonto = item.descuentoMonto || 0;
        const costoUnitario = (item.precioUnitario || 0) + costoFlete + costoSeguro + costoAduana - descuentoMonto;
        const cantidad = item.cantidad || 0;

        totalCantidadComprada += cantidad;
        costoTotalAcumulado += costoUnitario * cantidad;
        productoNombre = item.productoNombre || productoNombre;
      }
    }

    const cpp = totalCantidadComprada > 0 ? costoTotalAcumulado / totalCantidadComprada : 0;
    const ultimaCompra = compras.length > 0 ? compras[compras.length - 1].fecha : null;

    res.json({
      productoId,
      productoNombre,
      cpp: Math.round(cpp * 100) / 100,
      totalCantidadComprada,
      ultimaActualizacion: ultimaCompra,
    });
  } catch (error) {
    console.error('Error calculando CPP:', error);
    res.status(500).json({ error: 'Error al calcular CPP' });
  }
});

router.get('/proveedores/comparativa', authenticateToken, async (req: Request, res: Response) => {
  try {
    const db = database.db;
    if (!db) {
      res.status(500).json({ error: 'Base de datos no conectada' });
      return;
    }

    const compras = await database
      .getCollection('compras')
      .find({ estado: { $ne: 'cancelada' } })
      .allowDiskUse(true)
      .toArray();

    const proveedorMap = new Map<string, any>();

    for (const compra of compras) {
      const provId = compra.proveedorId;
      if (!proveedorMap.has(provId)) {
        proveedorMap.set(provId, {
          proveedorId: provId,
          proveedorNombre: compra.proveedorNombre,
          totalComprado: 0,
          cantidadItems: 0,
          precios: [] as number[],
          ultimaCompra: compra.fecha,
        });
      }

      const provData = proveedorMap.get(provId);
      provData.totalComprado += compra.total || 0;

      for (const item of compra.items) {
        provData.cantidadItems += item.cantidad || 0;
        provData.precios.push(item.precioUnitario || 0);
      }

      if (compra.fecha && (!provData.ultimaCompra || new Date(compra.fecha) > new Date(provData.ultimaCompra))) {
        provData.ultimaCompra = compra.fecha;
      }
    }

    const resultado = Array.from(proveedorMap.values()).map((prov) => ({
      proveedorId: prov.proveedorId,
      proveedorNombre: prov.proveedorNombre,
      totalComprado: prov.totalComprado,
      cantidadItems: prov.cantidadItems,
      precioPromedio: prov.precios.length > 0 ? prov.precios.reduce((a: number, b: number) => a + b, 0) / prov.precios.length : 0,
      ultimaCompra: prov.ultimaCompra,
    }));

    res.json(resultado);
  } catch (error) {
    console.error('Error obteniendo comparativa de proveedores:', error);
    res.status(500).json({ error: 'Error al obtener comparativa de proveedores' });
  }
});

router.get('/proveedores/inversion', authenticateToken, async (req: Request, res: Response) => {
  try {
    const db = database.db;
    if (!db) {
      res.status(500).json({ error: 'Base de datos no conectada' });
      return;
    }

    const compras = await database
      .getCollection('compras')
      .find({ estado: { $ne: 'cancelada' } })
      .allowDiskUse(true)
      .toArray();

    const proveedorMap = new Map<string, any>();

    for (const compra of compras) {
      const provId = compra.proveedorId;
      if (!proveedorMap.has(provId)) {
        proveedorMap.set(provId, {
          proveedorId: provId,
          proveedorNombre: compra.proveedorNombre,
          montoTotal: 0,
          cantidadCompras: 0,
          ultimaCompra: compra.fecha,
        });
      }

      const provData = proveedorMap.get(provId);
      provData.montoTotal += compra.total || 0;
      provData.cantidadCompras += 1;

      if (compra.fecha && (!provData.ultimaCompra || new Date(compra.fecha) > new Date(provData.ultimaCompra))) {
        provData.ultimaCompra = compra.fecha;
      }
    }

    const resultado = Array.from(proveedorMap.values());

    res.json(resultado);
  } catch (error) {
    console.error('Error obteniendo inversion por proveedor:', error);
    res.status(500).json({ error: 'Error al obtener inversion por proveedor' });
  }
});

router.get('/alertas', authenticateToken, async (req: Request, res: Response) => {
  try {
    const db = database.db;
    if (!db) {
      res.status(500).json({ error: 'Base de datos no conectada' });
      return;
    }

    const compras = await database
      .getCollection('compras')
      .find({ estado: { $ne: 'cancelada' } })
      .sort({ fecha: 1 })
      .allowDiskUse(true)
      .toArray();

    const alertas: any[] = [];

    const productoProveedorMap = new Map<string, any[]>();

    for (const compra of compras) {
      const key = `${compra.proveedorId}_${compra.proveedorNombre}`;
      if (!productoProveedorMap.has(key)) {
        productoProveedorMap.set(key, []);
      }

      for (const item of compra.items) {
        const itemKey = `${compra.proveedorId}_${item.productoId}`;
        const existing = productoProveedorMap.get(key)?.find((ci: any) => ci.productoId === item.productoId);
        if (!existing) {
          productoProveedorMap.get(key)?.push({
            productoId: item.productoId,
            productoNombre: item.productoNombre,
            costoUnitario: item.precioUnitario || 0,
            costoTotalUnitario: (item.precioUnitario || 0) + (item.costoFlete || 0) + (item.costoSeguro || 0) + (item.costoAduana || 0) - (item.descuentoMonto || 0),
            fecha: compra.fecha,
          });
        }
      }
    }

    for (const [provKey, provItems] of Array.from(productoProveedorMap.entries())) {
      const [proveedorId, proveedorNombre] = provKey.split('_');

      for (let i = 1; i < provItems.length; i++) {
        const anterior = provItems[i - 1];
        const nuevo = provItems[i];
        const aumento = ((nuevo.costoTotalUnitario - anterior.costoTotalUnitario) / anterior.costoTotalUnitario) * 100;

        if (aumento > 15) {
          const alertasCollection = db.collection('alertas-costos');
          const existe = await alertasCollection.findOne({
            productoId: nuevo.productoId,
            proveedorId,
            fechaDeteccion: { $exists: true },
          });

          if (!existe) {
            alertas.push({
              _id: undefined,
              productoId: nuevo.productoId,
              productoNombre: nuevo.productoNombre,
              proveedorId,
              proveedorNombre,
              costoAnterior: anterior.costoTotalUnitario,
              costoNuevo: nuevo.costoTotalUnitario,
              porcentajeAumento: Math.round(aumento * 100) / 100,
              fechaDeteccion: new Date(),
              revisada: false,
            });
          }
        }
      }
    }

    const alertasCollection = database.getCollection('alertas-costos');
    const alertasGuardadas = await alertasCollection.find({ revisada: false }).sort({ fechaDeteccion: -1 }).allowDiskUse(true).toArray();

    res.json(alertasGuardadas);
  } catch (error) {
    console.error('Error obteniendo alertas:', error);
    res.status(500).json({ error: 'Error al obtener alertas' });
  }
});

router.post('/alertas/:id/revisar', authenticateToken, async (req: Request, res: Response) => {
  try {
    const usuario = getUsuario(req);
    const db = database.db;
    if (!db) {
      res.status(500).json({ error: 'Base de datos no conectada' });
      return;
    }

    const idParam = req.params.id;
    const id = Array.isArray(idParam) ? idParam[0] : idParam;

    const result = await database
      .getCollection('alertas-costos')
      .findOneAndUpdate({ _id: new ObjectId(id) }, { $set: { revisada: true, fechaRevision: new Date(), revisadaPor: usuario } }, { returnDocument: 'after' });

    if (!result) {
      res.status(404).json({ error: 'Alerta no encontrada' });
      return;
    }

    res.json(result.value);
  } catch (error) {
    console.error('Error revisando alerta:', error);
    res.status(500).json({ error: 'Error al revisar alerta' });
  }
});

router.post('/acuerdos-comerciales', authenticateToken, async (req: Request, res: Response) => {
  try {
    const usuario = getUsuario(req);
    const db = database.db;
    if (!db) {
      res.status(500).json({ error: 'Base de datos no conectada' });
      return;
    }

    const { proveedorId, proveedorNombre, tipo, descripcion, porcentajeDescuento, montoMinimo, productoIds, fechaInicio, fechaFin } = req.body;

    if (!proveedorId || !proveedorNombre || !tipo || !descripcion || porcentajeDescuento === undefined || !fechaInicio || !fechaFin) {
      res.status(400).json({ error: 'proveedorId, proveedorNombre, tipo, descripcion, porcentajeDescuento, fechaInicio y fechaFin son requeridos' });
      return;
    }

    const tiposValidos = ['volumen', 'temporada', 'anticipado', 'anual'];
    if (!tiposValidos.includes(tipo)) {
      res.status(400).json({ error: 'Tipo debe ser: volumen, temporada, anticipado o anual' });
      return;
    }

    const acuerdoId = new ObjectId().toString();
    const acuerdo = {
      id: acuerdoId,
      proveedorId,
      proveedorNombre,
      tipo,
      descripcion,
      porcentajeDescuento,
      montoMinimo: montoMinimo || 0,
      productoIds: productoIds || [],
      fechaInicio: new Date(fechaInicio),
      fechaFin: new Date(fechaFin),
      activo: true,
      creadoPor: usuario,
      fechaCreacion: new Date(),
      updatedAt: new Date(),
    };

    const collection = database.getCollection('acuerdos-comerciales');
    await collection.insertOne(acuerdo);

    await crearRegistro(db, 'Creación', 'Acuerdos Comerciales', `Acuerdo comercial creado para proveedor: ${proveedorNombre}`, { acuerdoId, proveedorNombre, tipo, porcentajeDescuento }, usuario);

    res.status(201).json(acuerdo);
  } catch (error) {
    console.error('Error creando acuerdo comercial:', error);
    res.status(500).json({ error: 'Error al crear acuerdo comercial' });
  }
});

router.get('/acuerdos-comerciales', authenticateToken, async (req: Request, res: Response) => {
  try {
    const compras = await database
      .getCollection('acuerdos-comerciales')
      .find({})
      .sort({ fechaCreacion: -1 })
      .allowDiskUse(true)
      .toArray();

    res.json(compras);
  } catch (error) {
    console.error('Error obteniendo acuerdos comerciales:', error);
    res.status(500).json({ error: 'Error al obtener acuerdos comerciales' });
  }
});

router.get('/acuerdos-comerciales/proveedor/:proveedorId', authenticateToken, async (req: Request, res: Response) => {
  try {
    const { proveedorId } = req.params;

    const acuerdos = await database
      .getCollection('acuerdos-comerciales')
      .find({ proveedorId })
      .sort({ fechaCreacion: -1 })
      .allowDiskUse(true)
      .toArray();

    res.json(acuerdos);
  } catch (error) {
    console.error('Error obteniendo acuerdos por proveedor:', error);
    res.status(500).json({ error: 'Error al obtener acuerdos por proveedor' });
  }
});

router.put('/acuerdos-comerciales/:id', authenticateToken, async (req: Request, res: Response) => {
  try {
    const usuario = getUsuario(req);
    const db = database.db;
    if (!db) {
      res.status(500).json({ error: 'Base de datos no conectada' });
      return;
    }

    const idParam = req.params.id;
    const id = Array.isArray(idParam) ? idParam[0] : idParam;

    const { proveedorId, proveedorNombre, tipo, descripcion, porcentajeDescuento, montoMinimo, productoIds, fechaInicio, fechaFin, activo } = req.body;

    const updateData: any = {
      ...(proveedorId && { proveedorId }),
      ...(proveedorNombre && { proveedorNombre }),
      ...(tipo && { tipo }),
      ...(descripcion !== undefined && { descripcion }),
      ...(porcentajeDescuento !== undefined && { porcentajeDescuento }),
      ...(montoMinimo !== undefined && { montoMinimo }),
      ...(productoIds !== undefined && { productoIds }),
      ...(fechaInicio && { fechaInicio: new Date(fechaInicio) }),
      ...(fechaFin && { fechaFin: new Date(fechaFin) }),
      ...(activo !== undefined && { activo }),
      updatedAt: new Date(),
    };

    const result = await database
      .getCollection('acuerdos-comerciales')
      .findOneAndUpdate({ id }, { $set: updateData }, { returnDocument: 'after' });

    await crearRegistro(db, 'Modificación', 'Acuerdos Comerciales', `Acuerdo comercial actualizado: ${id}`, { acuerdoId: id, datos: updateData }, usuario);

    if (!result) {
      res.status(404).json({ error: 'Acuerdo comercial no encontrado' });
      return;
    }

    res.json(result.value);
  } catch (error) {
    console.error('Error actualizando acuerdo comercial:', error);
    res.status(500).json({ error: 'Error al actualizar acuerdo comercial' });
  }
});

router.delete('/acuerdos-comerciales/:id', authenticateToken, async (req: Request, res: Response) => {
  try {
    const usuario = getUsuario(req);
    const db = database.db;
    if (!db) {
      res.status(500).json({ error: 'Base de datos no conectada' });
      return;
    }

    const idParam = req.params.id;
    const id = Array.isArray(idParam) ? idParam[0] : idParam;

    const acuerdo = await database.getCollection('acuerdos-comerciales').findOne({ id });

    if (!acuerdo) {
      res.status(404).json({ error: 'Acuerdo comercial no encontrado' });
      return;
    }

    await database.getCollection('acuerdos-comerciales').deleteOne({ id });

    await crearRegistro(db, 'Eliminación', 'Acuerdos Comerciales', `Acuerdo comercial eliminado: ${id}`, { acuerdoId: id, proveedorNombre: acuerdo.proveedorNombre }, usuario);

    res.json({ success: true });
  } catch (error) {
    console.error('Error eliminando acuerdo comercial:', error);
    res.status(500).json({ error: 'Error al eliminar acuerdo comercial' });
  }
});

router.get('/reportes/rotacion', authenticateToken, async (req: Request, res: Response) => {
  try {
    const db = database.db;
    if (!db) {
      res.status(500).json({ error: 'Base de datos no conectada' });
      return;
    }

    const fechaLimite = new Date();
    fechaLimite.setDate(fechaLimite.getDate() - 30);

    const compras = await database
      .getCollection('compras')
      .find({ fecha: { $gte: fechaLimite }, estado: { $ne: 'cancelada' } })
      .allowDiskUse(true)
      .toArray();

    const rotacionMap = new Map<string, any>();

    for (const compra of compras) {
      for (const item of compra.items) {
        const key = item.productoId;
        if (!rotacionMap.has(key)) {
          rotacionMap.set(key, {
            productoId: item.productoId,
            productoNombre: item.productoNombre,
            cantidadComprada: 0,
            costoTotal: 0,
            numeroCompras: 0,
          });
        }

        const itemData = rotacionMap.get(key);
        itemData.cantidadComprada += item.cantidad || 0;
        itemData.costoTotal += (item.precioUnitario || 0) * (item.cantidad || 0);
        itemData.numeroCompras += 1;
      }
    }

    const resultado = Array.from(rotacionMap.values());

    res.json(resultado);
  } catch (error) {
    console.error('Error obteniendo reporte de rotacion:', error);
    res.status(500).json({ error: 'Error al obtener reporte de rotacion' });
  }
});

export default router;
