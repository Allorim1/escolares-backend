import { Router, Request, Response } from 'express';
import { database } from '../config/database';
import { authenticateToken } from '../middlewares/auth.middleware';
import { ObjectId } from 'mongodb';

const router = Router();

interface MensajeChat {
  _id?: ObjectId;
  emisorId: string;
  emisorNombre: string;
  receptorId: string;
  receptorNombre: string;
  mensaje: string;
  leido: boolean;
  fecha: Date;
}

router.post('/mensaje', authenticateToken, async (req: Request, res: Response) => {
  try {
    const { receptorId, mensaje } = req.body;
    const emisorId = req.user?.userId;
    const emisorNombre = req.user?.username || req.user?.nombre || 'Usuario';

    if (!receptorId || !mensaje || !emisorId) {
      res.status(400).json({ error: 'Faltan datos requeridos' });
      return;
    }

    const db = database.db;
    if (!db) {
      res.status(500).json({ error: 'Error de conexión' });
      return;
    }

    const usuariosCollection = db.collection('usuarios');
    const receptor = await usuariosCollection.findOne({ _id: new ObjectId(receptorId) });

    if (!receptor) {
      res.status(404).json({ error: 'Usuario receptor no encontrado' });
      return;
    }

    const chatCollection = db.collection('chat');
    const nuevoMensaje: MensajeChat = {
      emisorId,
      emisorNombre,
      receptorId,
      receptorNombre: receptor.username || receptor.nombre || 'Usuario',
      mensaje,
      leido: false,
      fecha: new Date(),
    };

    await chatCollection.insertOne(nuevoMensaje);
    res.json({ success: true, mensaje: nuevoMensaje });
  } catch (error) {
    console.error('Error enviando mensaje:', error);
    res.status(500).json({ error: 'Error enviando mensaje' });
  }
});

router.get('/conversaciones', authenticateToken, async (req: Request, res: Response) => {
  try {
    const userId = req.user?.userId;
    const db = database.db;
    
    if (!db) {
      res.status(500).json({ error: 'Error de conexión' });
      return;
    }

    const chatCollection = db.collection('chat');
    
    const conversaciones = await chatCollection.aggregate([
      {
        $match: {
          $or: [{ emisorId: userId }, { receptorId: userId }]
        }
      },
      {
        $sort: { fecha: -1 }
      },
      {
        $group: {
          _id: {
            $cond: [
              { $eq: ['$emisorId', userId] },
              '$receptorId',
              '$emisorId'
            ]
          },
          ultimoMensaje: { $first: '$$ROOT' }
        }
      }
    ]).toArray();

    const usuariosCollection = db.collection('usuarios');
    const result = await Promise.all(
      conversaciones.map(async (conv: any) => {
        const otroUsuarioId = conv._id;
        let otroUsuario = null;
        try {
          otroUsuario = await usuariosCollection.findOne({ _id: new ObjectId(otroUsuarioId) });
        } catch (e) {
          console.log('Error buscando usuario:', e);
        }
        return {
          usuarioId: otroUsuarioId,
          username: otroUsuario?.username || otroUsuario?.nombre || conv.ultimoMensaje.receptorNombre || conv.ultimoMensaje.emisorNombre,
          ultimoMensaje: conv.ultimoMensaje.mensaje,
          fecha: conv.ultimoMensaje.fecha,
          esEmisor: conv.ultimoMensaje.emisorId === userId,
        };
      })
    );

    res.json(result);
  } catch (error) {
    console.error('Error obteniendo conversaciones:', error);
    res.status(500).json({ error: 'Error obteniendo conversaciones' });
  }
});

router.get('/mensajes/:usuarioId', authenticateToken, async (req: Request, res: Response) => {
  try {
    const userId = req.user?.userId;
    const otroUsuarioId = req.params.usuarioId;
    const db = database.db;

    if (!db) {
      res.status(500).json({ error: 'Error de conexión' });
      return;
    }

    const chatCollection = db.collection('chat');

    const mensajes = await chatCollection.find({
      $or: [
        { emisorId: userId, receptorId: otroUsuarioId },
        { emisorId: otroUsuarioId, receptorId: userId }
      ]
    }).sort({ fecha: 1 }).toArray();

    await chatCollection.updateMany(
      { emisorId: otroUsuarioId, receptorId: userId, leido: false },
      { $set: { leido: true } }
    );

    res.json(mensajes);
  } catch (error) {
    console.error('Error obteniendo mensajes:', error);
    res.status(500).json({ error: 'Error obteniendo mensajes' });
  }
});

router.get('/usuarios', authenticateToken, async (req: Request, res: Response) => {
  try {
    const db = database.db;
    if (!db) {
      res.status(500).json({ error: 'Error de conexión' });
      return;
    }

    const usuariosCollection = db.collection('usuarios');
    const usuarios = await usuariosCollection.find(
      { rol: { $ne: 'root' } },
      { projection: { password: 0 } }
    ).toArray();

    res.json(usuarios);
  } catch (error) {
    console.error('Error obteniendo usuarios:', error);
    res.status(500).json({ error: 'Error obteniendo usuarios' });
  }
});

router.get('/admin/usuarios', authenticateToken, async (req: Request, res: Response) => {
  try {
    const userRol = req.user?.rol;
    if (userRol !== 'root' && userRol !== 'admin') {
      res.status(403).json({ error: 'No autorizado' });
      return;
    }

    const db = database.db;
    if (!db) {
      res.status(500).json({ error: 'Error de conexión' });
      return;
    }

    const usuariosCollection = db.collection('usuarios');
    const usuarios = await usuariosCollection.find(
      {},
      { projection: { password: 0 } }
    ).toArray();

    res.json(usuarios);
  } catch (error) {
    console.error('Error obteniendo usuarios:', error);
    res.status(500).json({ error: 'Error obteniendo usuarios' });
  }
});

export default router;