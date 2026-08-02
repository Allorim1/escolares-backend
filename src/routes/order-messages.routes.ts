import { Router, Request, Response } from 'express';
import { database } from '../config/database';
import { authenticateToken } from '../middlewares/auth.middleware';
import { ObjectId } from 'mongodb';

const router = Router();

interface OrderMessage {
  _id?: string;
  orderId: string;
  emisorId: string;
  emisorNombre: string;
  emisorRol: string;
  mensaje: string;
  leido: boolean;
  fecha: Date;
}

router.get('/order/:orderId', authenticateToken, async (req: Request, res: Response) => {
  try {
    const { orderId } = req.params;
    const userId = req.user?.userId;
    const userRol = req.user?.rol;

    if (!userId) {
      res.status(401).json({ error: 'No autorizado' });
      return;
    }

    const order = await database.getCollection('orders').findOne({ id: orderId });
    if (!order) {
      res.status(404).json({ error: 'Pedido no encontrado' });
      return;
    }

    if (userRol !== 'root' && userRol !== 'admin' && order.userId !== userId) {
      res.status(403).json({ error: 'No tiene permiso para ver los mensajes de este pedido' });
      return;
    }

    const messagesCollection = database.getCollection('orderMessages');
    const messages = await messagesCollection
      .find({ orderId })
      .sort({ fecha: 1 })
      .allowDiskUse(true)
      .toArray();

    res.json(messages);
  } catch (error) {
    console.error('Error obteniendo mensajes del pedido:', error);
    res.status(500).json({ error: 'Error al obtener mensajes' });
  }
});

router.post('/order/:orderId', authenticateToken, async (req: Request, res: Response) => {
  try {
    const { orderId } = req.params;
    const { mensaje } = req.body;
    const userId = req.user?.userId;
    const userName = req.user?.nombre || req.user?.username || req.user?.nombreCompleto || 'Usuario';
    const userRol = req.user?.rol || 'usuario';

    if (!userId) {
      res.status(401).json({ error: 'No autorizado' });
      return;
    }

    if (!mensaje || !mensaje.trim()) {
      res.status(400).json({ error: 'El mensaje es requerido' });
      return;
    }

    const order = await database.getCollection('orders').findOne({ id: orderId });
    if (!order) {
      res.status(404).json({ error: 'Pedido no encontrado' });
      return;
    }

    if (userRol !== 'root' && userRol !== 'admin' && order.userId !== userId) {
      res.status(403).json({ error: 'No tiene permiso para enviar mensajes en este pedido' });
      return;
    }

    const newMessage: OrderMessage = {
      orderId,
      emisorId: userId,
      emisorNombre: userName,
      emisorRol: userRol,
      mensaje: mensaje.trim(),
      leido: false,
      fecha: new Date(),
    };

    const messagesCollection = database.getCollection('orderMessages');
    const result = await messagesCollection.insertOne(newMessage);

    const io = req.app.get('io');
    if (io) {
      const messageData = {
        _id: result.insertedId.toString(),
        orderId,
        emisorId: userId,
        emisorNombre: userName,
        emisorRol: userRol,
        mensaje: mensaje.trim(),
        leido: false,
        fecha: new Date(),
      };

      io.to(`order-messages-${orderId}`).emit('nuevo-mensaje-pedido', messageData);
    }

    res.status(201).json({ success: true, mensaje: newMessage });
  } catch (error) {
    console.error('Error enviando mensaje del pedido:', error);
    res.status(500).json({ error: 'Error al enviar mensaje' });
  }
});

router.put('/order/:orderId/leer', authenticateToken, async (req: Request, res: Response) => {
  try {
    const { orderId } = req.params;
    const userId = req.user?.userId;

    if (!userId) {
      res.status(401).json({ error: 'No autorizado' });
      return;
    }

    const messagesCollection = database.getCollection('orderMessages');
    await messagesCollection.updateMany(
      { orderId, emisorId: { $ne: userId }, leido: false },
      { $set: { leido: true } }
    );

    res.json({ success: true });
  } catch (error) {
    console.error('Error marcando mensajes como leídos:', error);
    res.status(500).json({ error: 'Error al marcar mensajes como leídos' });
  }
});

export default router;
