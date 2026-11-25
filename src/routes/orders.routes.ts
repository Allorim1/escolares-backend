import { Router, Request, Response } from 'express';
import { database } from '../config/database';
import { authenticateToken } from '../middlewares/auth.middleware';
import { validateBody } from '../middlewares/validate.middleware';
import { Order, OrderStatus, ORDER_STATUS_TRANSITIONS } from '../models';

const router = Router();

const getAuthUser = async (userId?: string) => {
  if (!userId) return null;
  return database.getCollection<any>('users').findOne({ id: userId });
};
const isAdminRole = (user: any) => user?.rol === 'root' || user?.rol === 'admin' || user?.isAdmin === true;
const canManageOrderStatus = async (req: Request, order: Order, nextStatus: OrderStatus) => {
  const user = await getAuthUser(req.user?.userId);
  if (!user) return { ok: false, code: 401, error: 'No autorizado' };
  const admin = isAdminRole(user);
  const isOwner = order.userId === user.id;
  const isDelivery = user.rol === 'repartidor' && !!user.deliveryPersonId && user.deliveryPersonId === order.deliveryPersonId;

  const allowed: OrderStatus[] = ORDER_STATUS_TRANSITIONS[order.status] || [];
  if (!allowed.includes(nextStatus)) return { ok: false, code: 409, error: `Transición inválida: ${order.status} -> ${nextStatus}` };

  if (admin) return { ok: true, user };
  if (isOwner && nextStatus === 'cancelado' && ['confirmar', 'pendiente'].includes(order.status)) return { ok: true, user };
  if (isDelivery && nextStatus === 'enviado' && ['procesado', 'procesando'].includes(order.status)) return { ok: true, user };
  if (isDelivery && nextStatus === 'entregado' && order.status === 'enviado') return { ok: true, user };
  return { ok: false, code: 403, error: 'No tienes permisos para cambiar este estado' };
};


const crearRegistro = async (database: any, accion: string, modulo: string, descripcion: string, datos: any, usuario: string) => {
  const db = database.db;
  if (!db) return;
  let registrosCollection = db.collection('registros');
  const exists = await db.listCollections().toArray();
  const names = exists.map((c: any) => c.name);
  if (!names.includes('registros')) {
    await db.createCollection('registros');
    registrosCollection = db.collection('registros');
  }
  await registrosCollection.insertOne({
    accion,
    modulo,
    descripcion,
    datos,
    usuario,
    fecha: new Date(),
  });
};

// Emitir notificación de compra a todos los usuarios conectados
const emitirNotificacionCompra = (io: any, order: any) => {
  const notificacion = {
    tipo: 'compra',
    titulo: 'Nueva Compra Realizada',
    mensaje: `Se ha realizado una nueva compra por $${order.total}`,
    pedidoId: order.id,
    cliente: order.nombre,
    fecha: new Date(),
    imagenProducto: order.items && order.items.length > 0 ? order.items[0].image : null
  };
  
  console.log('Emitiendo notificación de compra:', notificacion);
  io.emit('notificacion-compra', notificacion);
};

router.get('/admin/all', authenticateToken, async (req: Request, res: Response) => {
   try {
     const userId = req.user?.userId;
     if (!userId) {
       res.status(401).json({ error: 'No autorizado' });
       return;
     }

     const user = await database.getCollection('users').findOne({ id: userId });
      if (!user || (user.rol !== 'root' && user.rol !== 'admin')) {
        res.status(403).json({ error: 'Acceso denegado' });
        return;
      }

      // Use aggregation to include delivery person location
     const orders = await database.getCollection('orders')
       .aggregate([
         { $sort: { createdAt: -1 } },
         {
           $lookup: {
             from: 'deliveryPersons',
             localField: 'deliveryPersonId',
             foreignField: 'id',
             as: 'deliveryPersonInfo'
           }
         },
         {
           $addFields: {
             repartidorUbicacion: {
               $cond: [
                 { $gt: [{ $size: '$deliveryPersonInfo' }, 0] },
                 { $arrayElemAt: ['$deliveryPersonInfo.ultimaUbicacion', 0] },
                 null
               ]
             }
           }
         },
         { $project: { deliveryPersonInfo: 0 } }
       ])
       .toArray();

     res.json(orders);
   } catch (error) {
     console.error('Error getting all orders:', error);
     res.status(500).json({ error: 'Error al obtener pedidos' });
   }
 });

router.get('/', authenticateToken, async (req: Request, res: Response) => {
  try {
    const userId = req.user?.userId;
    const userRole = req.user?.rol;
    
    if (!userId) {
      res.status(401).json({ error: 'No autorizado' });
      return;
    }

    let query = {};
    if (userRole === 'repartidor') {
      query = { deliveryPersonId: userId };
    } else if (userRole !== 'admin' && userRole !== 'root') {
      query = { userId };
    }

    // Agregar lookup del repartidor para obtener su ubicación
    const orders = await database.getCollection('orders')
      .aggregate([
        { $match: query },
        { $sort: { createdAt: -1 } },
        {
          $lookup: {
            from: 'deliveryPersons',
            localField: 'deliveryPersonId',
            foreignField: 'id',
            as: 'deliveryPersonInfo'
          }
        },
        {
          $addFields: {
            repartidorUbicacion: {
              $cond: [
                { $gt: [{ $size: '$deliveryPersonInfo' }, 0] },
                { $arrayElemAt: ['$deliveryPersonInfo.ultimaUbicacion', 0] },
                null
              ]
            }
          }
        },
        { $project: { deliveryPersonInfo: 0 } }
      ])
      .toArray();

    res.json(orders);
  } catch (error) {
    console.error('Error getting orders:', error);
    res.status(500).json({ error: 'Error al obtener pedidos' });
  }
});

router.get('/:id', authenticateToken, async (req: Request, res: Response) => {
  try {
    const userId = req.user?.userId;
    const { id } = req.params;

    if (!userId) {
      res.status(401).json({ error: 'No autorizado' });
      return;
    }

    const order = await database.getCollection<Order>('orders').findOne({ id, userId });

    if (!order) {
      res.status(404).json({ error: 'Pedido no encontrado' });
      return;
    }

    res.json(order);
  } catch (error) {
    console.error('Error getting order:', error);
    res.status(500).json({ error: 'Error al obtener pedido' });
  }
});

router.post('/', authenticateToken, validateBody({ items:{required:true,type:'array'}, total:{required:true,type:'number',min:0}, nombre:{required:true,type:'string',minLength:2,maxLength:120}, cedula:{required:true,type:'string',minLength:3,maxLength:40}, telefono:{required:true,type:'string',minLength:5,maxLength:40}, direccion:{required:true,type:'string',minLength:3,maxLength:500}, metodoPago:{required:true,type:'string',minLength:2,maxLength:80}, referencia:{type:'string',maxLength:120}, fotoComprobante:{type:'string',maxLength:20000000}, idempotencyKey:{type:'string',minLength:8,maxLength:128}, deliveryType:{type:'string',enum:['express','programado']}, scheduledFor:{type:'string',maxLength:40}, shippingRef:{type:'number',min:0,max:1000000}, shippingLabel:{type:'string',maxLength:120}, direccionCompleta:{type:'string',maxLength:500}, placeId:{type:'string',maxLength:200}, latitud:{type:'number'}, longitud:{type:'number'}, bancoEmisor:{type:'string',maxLength:120}, cedulaTitular:{type:'string',maxLength:40}, correo:{type:'string',maxLength:200} }), async (req: Request, res: Response) => {
  try {
    const userId = req.user?.userId;
    const { items, total, nombre, cedula, telefono, direccion, placeId, direccionCompleta, latitud, longitud, metodoPago, referencia, fotoComprobante, bancoEmisor, cedulaTitular, correo, idempotencyKey, deliveryType, scheduledFor, shippingRef, shippingLabel } = req.body;

    if (!userId) { res.status(401).json({ error: 'No autorizado' }); return; }
    if (!Array.isArray(items) || items.length === 0) { res.status(400).json({ error: 'El pedido debe tener productos' }); return; }

    const ordersCol = database.getCollection<Order>('orders');
    const idem = typeof idempotencyKey === 'string' ? idempotencyKey.trim() : '';
    if (idem) {
      const existing = await ordersCol.findOne({ userId, idempotencyKey: idem } as any);
      if (existing) { res.status(200).json(existing); return; }
    }

    const productsCol = database.getCollection<any>('products');
    const normalizedItems: any[] = [];
    const issues: any[] = [];
    let subtotal = 0;

    for (const raw of items) {
      const productId = String(raw?.productId ?? '').trim();
      const qty = Number(raw?.quantity);
      if (!productId || !Number.isInteger(qty) || qty < 1 || qty > 999) {
        issues.push({ productId, message: 'Cantidad inválida' });
        continue;
      }
      const product = await productsCol.findOne({ id: productId });
      if (!product) { issues.push({ productId, message: 'Producto no encontrado' }); continue; }

      const stock = Number(product.stock ?? product.existencia ?? product.cantidad ?? NaN);
      if (Number.isFinite(stock) && stock < qty) {
        issues.push({ productId, message: `Stock insuficiente (disponible: ${stock})`, available: stock, title: product.title });
      }

      const basePrice = Number(product.price ?? 0);
      const oferta = product.enOferta && Number(product.ofertaPorcentaje) > 0;
      const unitPrice = oferta ? +(basePrice * (1 - Number(product.ofertaPorcentaje) / 100)).toFixed(2) : +basePrice.toFixed(2);
      subtotal += unitPrice * qty;
      normalizedItems.push({
        productId,
        title: String(product.title || raw.title || ''),
        price: unitPrice,
        quantity: qty,
        image: String(product.image || raw.image || ''),
      });
    }

    if (issues.length > 0) { res.status(409).json({ error: 'No se pudo validar el pedido', details: issues }); return; }

    const safeShipping = Number.isFinite(Number(shippingRef)) && Number(shippingRef) >= 0 ? +Number(shippingRef).toFixed(2) : 0;
    const iva = +(subtotal * 0.16).toFixed(2);
    const computedTotal = +(subtotal + iva + safeShipping).toFixed(2);
    const clientTotal = +Number(total).toFixed(2);
    if (Math.abs(computedTotal - clientTotal) > 0.05) {
      res.status(409).json({ error: 'El total del pedido cambió. Actualiza tu carrito e intenta de nuevo.', details: [{ message: `Total esperado ${computedTotal.toFixed(2)}, recibido ${clientTotal.toFixed(2)}` }] });
      return;
    }

    // stock decrement where tracked
    for (const item of normalizedItems) {
      const product = await productsCol.findOne({ id: item.productId });
      const stock = Number(product?.stock ?? product?.existencia ?? product?.cantidad ?? NaN);
      if (Number.isFinite(stock)) {
        const inc: any = { purchases: item.quantity };
        const filter: any = { id: item.productId };
        if (product.stock !== undefined) { inc.stock = -item.quantity; filter.stock = { $gte: item.quantity }; }
        else if (product.existencia !== undefined) { inc.existencia = -item.quantity; filter.existencia = { $gte: item.quantity }; }
        else if (product.cantidad !== undefined) { inc.cantidad = -item.quantity; filter.cantidad = { $gte: item.quantity }; }
        const dec = await productsCol.updateOne(filter, { $inc: inc });
        if (!dec.matchedCount) {
          res.status(409).json({ error: 'Stock insuficiente', details: [{ productId: item.productId, title: item.title, message: 'Stock insuficiente al confirmar' }] });
          return;
        }
      } else {
        await productsCol.updateOne({ id: item.productId }, { $inc: { purchases: item.quantity } }).catch(() => {});
      }
    }

    const newOrder: any = {
      id: Date.now().toString(),
      userId,
      items: normalizedItems,
      total: computedTotal,
      nombre,
      cedula,
      telefono,
      direccion,
      placeId: placeId || '',
      direccionCompleta: direccionCompleta || direccion,
      ...(typeof latitud === 'number' && !Number.isNaN(latitud) ? { latitud } : {}),
      ...(typeof longitud === 'number' && !Number.isNaN(longitud) ? { longitud } : {}),
      metodoPago,
      referencia: referencia || '',
      fotoComprobante: fotoComprobante || '',
      bancoEmisor: bancoEmisor || '',
      cedulaTitular: cedulaTitular || '',
      correo: correo || '',
      ...(idem ? { idempotencyKey: idem } : {}),
      deliveryType: deliveryType || 'express',
      scheduledFor: scheduledFor || '',
      shippingRef: safeShipping,
      shippingLabel: shippingLabel || '',
      status: 'pendiente',
      historial: [{ status: 'pendiente', fecha: new Date(), observaciones: 'Pedido recibido, esperando confirmación' }],
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    await ordersCol.insertOne(newOrder);
    const io = req.app.get('io');
    if (io) emitirNotificacionCompra(io, newOrder);
    res.status(201).json(newOrder);
  } catch (error: any) {
    if (error?.code === 11000) {
      const userId = req.user?.userId;
      const key = String(req.body?.idempotencyKey || '').trim();
      if (userId && key) {
        const existing = await database.getCollection<Order>('orders').findOne({ userId, idempotencyKey: key } as any).catch(() => null);
        if (existing) { res.status(200).json(existing); return; }
      }
    }
    console.error('Error creating order:', error);
    res.status(500).json({ error: 'Error al crear pedido' });
  }
});

router.put('/:id/status', authenticateToken, validateBody({ status:{required:true,type:'string',enum:['confirmar','pendiente','procesando','procesado','enviado','entregado','cancelado']}, observaciones:{type:'string',maxLength:500} }), async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { status, observaciones } = req.body as { status: OrderStatus; observaciones?: string };
    const order = await database.getCollection<Order>('orders').findOne({ id });
    if (!order) { res.status(404).json({ error: 'Pedido no encontrado' }); return; }

    const check = await canManageOrderStatus(req, order, status);
    if (!check.ok) { res.status(check.code || 403).json({ error: check.error }); return; }
    const actor = check.user;
    const usuario = actor?.nombreCompleto || actor?.username || actor?.email || 'Sistema';

    if (status === 'entregado' && !order.facturaImage) {
      res.status(400).json({ error: 'Debe subir una factura/evidencia antes de marcar el pedido como entregado' });
      return;
    }

    const statusLabels: Record<OrderStatus, string> = {
      confirmar: 'Esperando confirmación', pendiente: 'Pedido recibido', procesando: 'Pedido en proceso', procesado: 'Pedido aceptado por repartidor', enviado: 'Pedido enviado', entregado: 'Pedido entregado', cancelado: 'Pedido cancelado',
    };

    const updatedHistorial = [...(order.historial || []), { status, fecha: new Date(), observaciones: observaciones || statusLabels[status] }];
    const setData: any = { status, historial: updatedHistorial, updatedAt: new Date() };

    // Restock once if cancelled after stock may have been decremented
    if (status === 'cancelado' && order.status !== 'cancelado' && !(order as any).stockRestored) {
      const productsCol = database.getCollection<any>('products');
      for (const item of order.items || []) {
        const product = await productsCol.findOne({ id: String(item.productId) });
        if (!product) continue;
        const inc: any = { purchases: -Number(item.quantity || 0) };
        if (product.stock !== undefined) inc.stock = Number(item.quantity || 0);
        if (product.existencia !== undefined) inc.existencia = Number(item.quantity || 0);
        if (product.cantidad !== undefined) inc.cantidad = Number(item.quantity || 0);
        await productsCol.updateOne({ id: String(item.productId) }, { $inc: inc }).catch(() => {});
      }
      setData.stockRestored = true;
      setData.stockRestoredAt = new Date();
    }

    const result = await database.getCollection<Order>('orders').findOneAndUpdate(
      { id },
      { $set: setData },
      { returnDocument: 'after' }
    );

    await crearRegistro(database, 'Modificación', 'Pedidos', `Pedido #${id.slice(-8)} cambió a: ${statusLabels[status]}`, { pedidoId: id, estadoAnterior: order.status, estadoNuevo: status, observaciones }, usuario);
    const io = req.app.get('io');
    if (io) io.emit('pedido-estado-cambiado', { orderId: id, status, previousStatus: order.status, actorId: actor?.id || null });
    res.json(result);
  } catch (error) {
    console.error('Error updating order status:', error);
    res.status(500).json({ error: 'Error al actualizar estado del pedido' });
  }
});

router.put('/:id/cancel-authorize', authenticateToken, validateBody({ motivo:{required:true,type:'string',minLength:3,maxLength:500}, claveSupervisor:{required:true,type:'string',minLength:2,maxLength:120} }), async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { motivo, claveSupervisor } = req.body;

    if (!motivo || !claveSupervisor) {
      res.status(400).json({ error: 'Motivo y clave de supervisor son requeridos' });
      return;
    }

    const order = await database.getCollection<Order>('orders').findOne({ id });

    if (!order) {
      res.status(404).json({ error: 'Pedido no encontrado' });
      return;
    }

    if (order.status === 'entregado' || order.status === 'cancelado') {
      res.status(400).json({ error: 'Solo se pueden cancelar pedidos en estados anteriores a entregado o ya cancelados' });
      return;
    }

    const supervisor = await database.getCollection('users').findOne({ supervisorKey: claveSupervisor });

    if (!supervisor) {
      res.status(403).json({ error: 'Clave de supervisor inválida' });
      return;
    }

    const usuario = req.user?.nombre || req.user?.username || req.user?.email || 'Sistema';
    const supervisorNombre = supervisor.nombreCompleto || supervisor.username || 'Supervisor';

    const updatedHistorial = [
      ...order.historial,
      {
        status: 'cancelado' as OrderStatus,
        fecha: new Date(),
        observaciones: `Cancelado por ${supervisorNombre}: ${motivo}`,
      },
    ];

    const cancelSet: any = {
      status: 'cancelado',
      historial: updatedHistorial,
      autorizadoPor: supervisor.id,
      autorizadoNombre: supervisorNombre,
      updatedAt: new Date(),
    };
    if (!(order as any).stockRestored) {
      const productsCol = database.getCollection<any>('products');
      for (const item of order.items || []) {
        const product = await productsCol.findOne({ id: String(item.productId) });
        if (!product) continue;
        const inc: any = { purchases: -Number(item.quantity || 0) };
        if (product.stock !== undefined) inc.stock = Number(item.quantity || 0);
        if (product.existencia !== undefined) inc.existencia = Number(item.quantity || 0);
        if (product.cantidad !== undefined) inc.cantidad = Number(item.quantity || 0);
        await productsCol.updateOne({ id: String(item.productId) }, { $inc: inc }).catch(() => {});
      }
      cancelSet.stockRestored = true;
      cancelSet.stockRestoredAt = new Date();
    }

    const result = await database.getCollection<Order>('orders').findOneAndUpdate(
      { id, status: { $ne: 'cancelado' } as any },
      { $set: cancelSet },
      { returnDocument: 'after' }
    );
    if (!result) { res.status(409).json({ error: 'El pedido ya fue cancelado' }); return; }

    await crearRegistro(database, 'Cancelación', 'Pedidos', `Pedido #${id.slice(-8)} cancelado por ${supervisorNombre}`, { pedidoId: id, motivo, supervisorId: supervisor.id }, usuario);

    const io = req.app.get('io');
    if (io) io.emit('pedido-estado-cambiado', { orderId: id, status: 'cancelado', previousStatus: order.status, actorId: req.user?.userId || null });
    res.json(result);
  } catch (error) {
    console.error('Error canceling order:', error);
    res.status(500).json({ error: 'Error al cancelar pedido' });
  }
});

router.put('/:id/factura', authenticateToken, validateBody({ facturaImage:{required:true,type:'string',minLength:10,maxLength:20000000} }), async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { facturaImage } = req.body;

    if (!facturaImage) {
      res.status(400).json({ error: 'Imagen de factura es requerida' });
      return;
    }

    const order = await database.getCollection<Order>('orders').findOne({ id });

    if (!order) {
      res.status(404).json({ error: 'Pedido no encontrado' });
      return;
    }

    const actor = await getAuthUser(req.user?.userId);
    const admin = isAdminRole(actor);
    const deliveryOwner = actor?.rol === 'repartidor' && actor?.deliveryPersonId && actor.deliveryPersonId === order.deliveryPersonId;
    if (!admin && !deliveryOwner) { res.status(403).json({ error: 'No tiene permisos para subir facturas' }); return; }

    const result = await database.getCollection<Order>('orders').findOneAndUpdate(
      { id },
      {
        $set: {
          facturaImage,
          updatedAt: new Date(),
        },
      },
      { returnDocument: 'after' }
    );

    await crearRegistro(database, 'Actualización', 'Pedidos', `Factura subida para pedido #${id.slice(-8)}`, { pedidoId: id }, actor?.nombreCompleto || actor?.username || actor?.email || 'Sistema');

    const io = req.app.get('io');
    if (io) io.emit('pedido-factura-subida', { orderId: id, actorId: req.user?.userId || null });
    res.json(result);
  } catch (error) {
    console.error('Error uploading factura:', error);
    res.status(500).json({ error: 'Error al subir factura' });
  }
});

router.put('/:id/assign-delivery', authenticateToken, validateBody({ deliveryPersonId:{required:true,type:'string',minLength:1,maxLength:120}, deliveryPersonName:{type:'string',maxLength:200} }), async (req: Request, res: Response) => {
  try {
    const actor = await getAuthUser(req.user?.userId);
    if (!isAdminRole(actor)) { res.status(403).json({ error: 'Acceso denegado' }); return; }
    const { id } = req.params;
    const { deliveryPersonId } = req.body as { deliveryPersonId: string; deliveryPersonName?: string };
    const order = await database.getCollection<Order>('orders').findOne({ id });
    if (!order) { res.status(404).json({ error: 'Pedido no encontrado' }); return; }
    if (['entregado', 'cancelado'].includes(order.status)) { res.status(409).json({ error: 'No se puede asignar repartidor a un pedido cerrado' }); return; }

    const deliveryPerson = await database.getCollection<any>('deliveryPersons').findOne({ id: String(deliveryPersonId) });
    if (!deliveryPerson) { res.status(404).json({ error: 'Repartidor no encontrado' }); return; }

    const result = await database.getCollection<Order>('orders').findOneAndUpdate(
      { id },
      { $set: { deliveryPersonId: String(deliveryPersonId), deliveryPersonName: String(deliveryPerson.nombre || ''), updatedAt: new Date() } },
      { returnDocument: 'after' }
    );

    const usuario = actor?.nombreCompleto || actor?.username || actor?.email || 'Sistema';
    await crearRegistro(database, 'Asignación', 'Pedidos', `Repartidor asignado a pedido #${id.slice(-8)}: ${deliveryPerson.nombre || ''}`, { pedidoId: id, deliveryPersonId, deliveryPersonName: deliveryPerson.nombre || '' }, usuario);
    const io = req.app.get('io');
    if (io) io.emit('pedido-repartidor-asignado', { orderId: id, deliveryPersonId: String(deliveryPersonId), deliveryPersonName: deliveryPerson.nombre || '', actorId: req.user?.userId || null });
    res.json(result);
  } catch (error) {
    console.error('Error assigning delivery person:', error);
    res.status(500).json({ error: 'Error al asignar repartidor' });
  }
});

router.delete('/:id', authenticateToken, async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const userId = req.user?.userId;

    const order = await database.getCollection<Order>('orders').findOne({ id, userId });

    if (!order) {
      res.status(404).json({ error: 'Pedido no encontrado' });
      return;
    }

    if (!['confirmar','pendiente'].includes(order.status)) {
      res.status(400).json({ error: 'Solo se pueden eliminar pedidos antes de ser procesados' });
      return;
    }

    await database.getCollection<Order>('orders').deleteOne({ id });

    res.json({ success: true });
  } catch (error) {
    console.error('Error deleting order:', error);
    res.status(500).json({ error: 'Error al eliminar pedido' });
  }
});

router.put('/:id/accept', authenticateToken, async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const userId = req.user?.userId;

    if (!userId) {
      res.status(401).json({ error: 'No autorizado' });
      return;
    }

    const order = await database.getCollection<Order>('orders').findOne({ id });

    if (!order) {
      res.status(404).json({ error: 'Pedido no encontrado' });
      return;
    }

    // Get delivery person info
    const user = await database.getCollection('users').findOne({ id: userId });
    if (!user || !user.deliveryPersonId) {
      res.status(403).json({ error: 'No estás vinculado a un repartidor' });
      return;
    }

    const deliveryPerson = await database.getCollection('deliveryPersons').findOne({ id: user.deliveryPersonId });
    if (!deliveryPerson) {
      res.status(403).json({ error: 'Repartidor no encontrado' });
      return;
    }

    if (!['procesando'].includes(order.status)) {
      res.status(400).json({ error: 'Solo se pueden aceptar pedidos en estado procesando' });
      return;
    }
    if (order.deliveryPersonId && order.deliveryPersonId !== user.deliveryPersonId) {
      res.status(403).json({ error: 'Este pedido ya está asignado a otro repartidor' });
      return;
    }

    const statusLabels: Record<OrderStatus, string> = {
      confirmar: 'Esperando confirmación',
      pendiente: 'Pedido recibido',
      procesando: 'Pedido en proceso',
      procesado: 'Pedido aceptado por repartidor',
      enviado: 'Pedido enviado',
      entregado: 'Pedido entregado',
      cancelado: 'Pedido cancelado',
    };

    const updatedHistorial = [
      ...order.historial,
      {
        status: 'procesado' as OrderStatus,
        fecha: new Date(),
        observaciones: 'Pedido aceptado por el repartidor',
      },
    ];

    // If order is unassigned, assign it to this delivery person
    const updateData: any = {
      status: 'procesado',
      historial: updatedHistorial,
      updatedAt: new Date(),
    };

    if (!order.deliveryPersonId) {
      updateData.deliveryPersonId = user.deliveryPersonId;
      updateData.deliveryPersonName = deliveryPerson.nombre;
    } else if (user.deliveryPersonId !== order.deliveryPersonId) {
      res.status(403).json({ error: 'No tienes permiso para aceptar este pedido' });
      return;
    }

    const result = await database.getCollection<Order>('orders').findOneAndUpdate(
      { id },
      { $set: updateData },
      { returnDocument: 'after' }
    );

    const usuario = req.user?.nombre || req.user?.username || req.user?.email || 'Sistema';
    await crearRegistro(database, 'Aceptación', 'Pedidos', `Pedido #${id.slice(-8)} aceptado por repartidor`, { pedidoId: id }, usuario);

    res.json(result);
  } catch (error) {
    console.error('Error accepting order:', error);
    res.status(500).json({ error: 'Error al aceptar pedido' });
  }
});

router.put('/:id/reject', authenticateToken, async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { motivo } = req.body;
    const userId = req.user?.userId;

    if (!userId) {
      res.status(401).json({ error: 'No autorizado' });
      return;
    }

    const order = await database.getCollection<Order>('orders').findOne({ id });

    if (!order) {
      res.status(404).json({ error: 'Pedido no encontrado' });
      return;
    }

    if (order.status !== 'procesado') {
      res.status(400).json({ error: 'Solo se pueden rechazar pedidos en estado procesado' });
      return;
    }

    const user = await database.getCollection('users').findOne({ id: userId });
    if (!user || user.deliveryPersonId !== order.deliveryPersonId) {
      res.status(403).json({ error: 'No tienes permiso para rechazar este pedido' });
      return;
    }

    const updatedHistorial = [
      ...order.historial,
      {
        status: 'procesando' as OrderStatus,
        fecha: new Date(),
        observaciones: motivo ? `Pedido rechazado por el repartidor: ${motivo}` : 'Pedido rechazado por el repartidor',
      },
    ];

    const result = await database.getCollection<Order>('orders').findOneAndUpdate(
      { id },
      {
        $set: {
          status: 'procesando',
          historial: updatedHistorial,
          updatedAt: new Date(),
        },
        $unset: {
          deliveryPersonId: '',
          deliveryPersonName: '',
        },
      },
      { returnDocument: 'after' }
    );

    const usuario = req.user?.nombre || req.user?.username || req.user?.email || 'Sistema';
    await crearRegistro(database, 'Rechazo', 'Pedidos', `Pedido #${id.slice(-8)} rechazado por repartidor`, { pedidoId: id, motivo: motivo || 'Sin motivo' }, usuario);

    res.json(result);
  } catch (error) {
    console.error('Error rejecting order:', error);
    res.status(500).json({ error: 'Error al rechazar pedido' });
  }
});

router.get('/delivery/assigned', authenticateToken, async (req: Request, res: Response) => {
   try {
     const { status, deliveryPersonId } = req.query;
     const userId = req.user?.userId;
     const userRol = req.user?.rol;
     
     let filter: any = {};
     
     // Si es repartidor, solo ver sus propios pedidos
     if (userRol === 'repartidor') {
       const user = await database.getCollection('users').findOne({ id: userId });
       if (!user?.deliveryPersonId) {
         res.status(403).json({ error: 'No estás vinculado a un repartidor' });
         return;
       }
       filter.deliveryPersonId = user.deliveryPersonId;
     } else if (deliveryPersonId) {
       filter.deliveryPersonId = deliveryPersonId;
     } else {
       filter.deliveryPersonId = { $exists: true, $ne: null };
     }
     
     if (status) {
       filter.status = status;
     }
     
     const orders = await database.getCollection<Order>('orders')
       .find(filter)
       .sort({ createdAt: -1 })
       .toArray();
     
     const ordersWithProducts = orders.map(order => ({
       ...order,
       products: order.items?.map(item => ({
         id: item.productId,
         name: item.title,
         price: item.price,
         quantity: item.quantity,
         image: item.image
       })) || []
     }));
     
     res.json(ordersWithProducts);
   } catch (error) {
     console.error('Error fetching assigned orders:', error);
     res.status(500).json({ error: 'Error al obtener pedidos asignados' });
   }
  });

// Get available orders for delivery person to accept
router.get('/delivery/available', authenticateToken, async (req: Request, res: Response) => {
   try {
     const userId = req.user?.userId;
     const user = await database.getCollection('users').findOne({ id: userId });
     
     if (!user || user.rol !== 'repartidor') {
       res.status(403).json({ error: 'Solo los repartidores pueden ver pedidos disponibles' });
       return;
     }

     // Check if delivery person is active
     const deliveryPerson = await database.getCollection('deliveryPersons').findOne({ id: user.deliveryPersonId });
     if (!deliveryPerson || !deliveryPerson.activo) {
       res.json([]);
       return;
     }
     
     const orders = await database.getCollection<Order>('orders')
       .find({ 
         status: 'procesando',
         deliveryPersonId: { $exists: false }
       })
       .sort({ createdAt: -1 })
       .toArray();
     
     const ordersWithProducts = orders.map(order => ({
       ...order,
       products: order.items?.map(item => ({
         id: item.productId,
         name: item.title,
         price: item.price,
         quantity: item.quantity,
         image: item.image
       })) || []
     }));
     
     res.json(ordersWithProducts);
   } catch (error) {
     console.error('Error fetching available orders:', error);
     res.status(500).json({ error: 'Error al obtener pedidos disponibles' });
   }
  });

export default router;