import { Router, Request, Response } from 'express';
import { database } from '../config/database';
import { authenticateToken } from '../middlewares/auth.middleware';
import { Order, OrderStatus } from '../models';

const router = Router();

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
    if (!user || (user.rol !== 'root' && user.rol !== 'owner')) {
      res.status(403).json({ error: 'Acceso denegado' });
      return;
    }

    const orders = await database.getCollection<Order>('orders')
      .find({})
      .sort({ createdAt: -1 })
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
    if (!userId) {
      res.status(401).json({ error: 'No autorizado' });
      return;
    }

    const orders = await database.getCollection<Order>('orders')
      .find({ userId })
      .sort({ createdAt: -1 })
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

router.post('/', authenticateToken, async (req: Request, res: Response) => {
  try {
    const userId = req.user?.userId;
    const { items, total, nombre, cedula, telefono, direccion, metodoPago, referencia, fotoComprobante } = req.body;

    if (!userId) {
      res.status(401).json({ error: 'No autorizado' });
      return;
    }

    if (!items || items.length === 0) {
      res.status(400).json({ error: 'El pedido debe tener productos' });
      return;
    }

    const newOrder: Order = {
      id: Date.now().toString(),
      userId,
      items,
      total,
      nombre,
      cedula,
      telefono,
      direccion,
      metodoPago,
      referencia,
      fotoComprobante: fotoComprobante || '',
      status: 'pendiente',
      historial: [
        {
          status: 'pendiente',
          fecha: new Date(),
          observaciones: 'Pedido recibido, esperando confirmación',
        },
      ],
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    await database.getCollection<Order>('orders').insertOne(newOrder);

    // Emitir notificación de compra a todos los usuarios conectados
    const io = req.app.get('io');
    if (io) {
      emitirNotificacionCompra(io, newOrder);
    }

    res.status(201).json(newOrder);
  } catch (error) {
    console.error('Error creating order:', error);
    res.status(500).json({ error: 'Error al crear pedido' });
  }
});

router.put('/:id/status', authenticateToken, async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { status, observaciones } = req.body;
    const usuario = req.user?.nombre || req.user?.username || req.user?.email || 'Sistema';

    if (!status) {
      res.status(400).json({ error: 'Estado requerido' });
      return;
    }

    const validStatuses: OrderStatus[] = ['confirmar', 'pendiente', 'procesando', 'enviado', 'entregado', 'cancelado'];
    if (!validStatuses.includes(status)) {
      res.status(400).json({ error: 'Estado inválido' });
      return;
    }

    const order = await database.getCollection<Order>('orders').findOne({ id });

    if (!order) {
      res.status(404).json({ error: 'Pedido no encontrado' });
      return;
    }

    // Validación: si el estado es "entregado", debe tener facturaImage
    if (status === 'entregado' && !order.facturaImage) {
      res.status(400).json({ error: 'Debe subir una factura antes de marcar el pedido como entregado' });
      return;
    }

    const statusLabels: Record<OrderStatus, string> = {
      confirmar: 'Esperando confirmación',
      pendiente: 'Pedido recibido',
      procesando: 'Pedido en proceso',
      enviado: 'Pedido enviado',
      entregado: 'Pedido entregado',
      cancelado: 'Pedido cancelado',
    };

    const validStatus = status as OrderStatus;
    const updatedHistorial = [
      ...order.historial,
      {
        status: validStatus,
        fecha: new Date(),
        observaciones: observaciones || statusLabels[validStatus],
      },
    ];

    const result = await database.getCollection<Order>('orders').findOneAndUpdate(
      { id },
      {
        $set: {
          status: validStatus,
          historial: updatedHistorial,
          updatedAt: new Date(),
        },
      },
      { returnDocument: 'after' }
    );

    await crearRegistro(database, 'Modificación', 'Pedidos', `Pedido #${id.slice(-8)} cambió a: ${statusLabels[validStatus]}`, { pedidoId: id, estadoAnterior: order.status, estadoNuevo: validStatus, observaciones }, usuario);

    res.json(result);
  } catch (error) {
    console.error('Error updating order status:', error);
    res.status(500).json({ error: 'Error al actualizar estado del pedido' });
  }
});

router.put('/:id/cancel-authorize', authenticateToken, async (req: Request, res: Response) => {
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

    const result = await database.getCollection<Order>('orders').findOneAndUpdate(
      { id },
      {
        $set: {
          status: 'cancelado',
          historial: updatedHistorial,
          autorizadoPor: supervisor.id,
          autorizadoNombre: supervisorNombre,
          updatedAt: new Date(),
        },
      },
      { returnDocument: 'after' }
    );

    await crearRegistro(database, 'Cancelación', 'Pedidos', `Pedido #${id.slice(-8)} cancelado por ${supervisorNombre}`, { pedidoId: id, motivo, supervisorId: supervisor.id }, usuario);

    res.json(result);
  } catch (error) {
    console.error('Error canceling order:', error);
    res.status(500).json({ error: 'Error al cancelar pedido' });
  }
});

router.put('/:id/factura', authenticateToken, async (req: Request, res: Response) => {
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

    // Solo usuarios con permisos de admin/owner pueden subir facturas
    const user = await database.getCollection('users').findOne({ id: req.user?.userId });
    if (!user || (user.rol !== 'root' && user.rol !== 'owner' && user.rol !== 'usuario')) {
      res.status(403).json({ error: 'No tiene permisos para subir facturas' });
      return;
    }

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

    await crearRegistro(database, 'Actualización', 'Pedidos', `Factura subida para pedido #${id.slice(-8)}`, { pedidoId: id }, user.nombre || user.username || 'Sistema');

    res.json(result);
  } catch (error) {
    console.error('Error uploading factura:', error);
    res.status(500).json({ error: 'Error al subir factura' });
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

    if (order.status !== 'confirmar') {
      res.status(400).json({ error: 'Solo se pueden eliminar pedidos en espera de confirmación' });
      return;
    }

    await database.getCollection<Order>('orders').deleteOne({ id });

    res.json({ success: true });
  } catch (error) {
    console.error('Error deleting order:', error);
    res.status(500).json({ error: 'Error al eliminar pedido' });
  }
});

export default router;
