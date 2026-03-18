import { Router, Request, Response } from 'express';
import { database } from '../config/database';
import { authenticateToken } from '../middlewares/auth.middleware';
import { Order, OrderStatus } from '../models';

const router = Router();

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
    const { items, total, nombre, cedula, telefono, direccion, metodoPago, referencia } = req.body;

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

    if (!status) {
      res.status(400).json({ error: 'Estado requerido' });
      return;
    }

    const validStatuses: OrderStatus[] = ['pendiente', 'procesando', 'enviado', 'entregado', 'cancelado'];
    if (!validStatuses.includes(status)) {
      res.status(400).json({ error: 'Estado inválido' });
      return;
    }

    const order = await database.getCollection<Order>('orders').findOne({ id });

    if (!order) {
      res.status(404).json({ error: 'Pedido no encontrado' });
      return;
    }

    const statusLabels: Record<OrderStatus, string> = {
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

    res.json(result);
  } catch (error) {
    console.error('Error updating order status:', error);
    res.status(500).json({ error: 'Error al actualizar estado del pedido' });
  }
});

export default router;
