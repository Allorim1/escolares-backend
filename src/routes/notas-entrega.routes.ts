import { Router, Request, Response } from 'express';
import { database } from '../config/database';
import { authenticateToken } from '../middlewares/auth.middleware';

const router = Router();

router.get('/', authenticateToken, async (req: Request, res: Response) => {
  try {
    const db = database.db;
    if (!db) {
      res.status(500).json({ error: 'Error de conexión' });
      return;
    }

    const notas = await db.collection('notas-entrega')
      .find({})
      .sort({ fecha: -1 })
      .toArray();

    res.json(notas);
  } catch (error) {
    console.error('Error obteniendo notas de entrega:', error);
    res.status(500).json({ error: 'Error obteniendo notas de entrega' });
  }
});

router.get('/:id', authenticateToken, async (req: Request, res: Response) => {
  try {
    const db = database.db;
    if (!db) {
      res.status(500).json({ error: 'Error de conexión' });
      return;
    }

    const { ObjectId } = require('mongodb');
    const nota = await db.collection('notas-entrega').findOne({ _id: new ObjectId(req.params.id) });

    if (!nota) {
      res.status(404).json({ error: 'Nota de entrega no encontrada' });
      return;
    }

    res.json(nota);
  } catch (error) {
    console.error('Error obteniendo nota de entrega:', error);
    res.status(500).json({ error: 'Error obteniendo nota de entrega' });
  }
});

router.post('/', authenticateToken, async (req: Request, res: Response) => {
  try {
    const db = database.db;
    if (!db) {
      res.status(500).json({ error: 'Error de conexión' });
      return;
    }

    const nota = req.body;
    nota.fecha = new Date(nota.fecha);

    const result = await db.collection('notas-entrega').insertOne(nota);
    res.json({ success: true, _id: result.insertedId });
  } catch (error) {
    console.error('Error creando nota de entrega:', error);
    res.status(500).json({ error: 'Error creando nota de entrega' });
  }
});

router.put('/:id', authenticateToken, async (req: Request, res: Response) => {
  try {
    const db = database.db;
    if (!db) {
      res.status(500).json({ error: 'Error de conexión' });
      return;
    }

    const { ObjectId } = require('mongodb');
    const id = req.params.id;
    const nota = req.body;

    if (!id || Array.isArray(id)) {
      res.status(400).json({ error: 'ID inválido' });
      return;
    }

    await db.collection('notas-entrega').updateOne(
      { _id: new ObjectId(id) },
      { $set: nota }
    );

    res.json({ success: true });
  } catch (error) {
    console.error('Error actualizando nota de entrega:', error);
    res.status(500).json({ error: 'Error actualizando nota de entrega' });
  }
});

router.delete('/:id', authenticateToken, async (req: Request, res: Response) => {
  try {
    const db = database.db;
    if (!db) {
      res.status(500).json({ error: 'Error de conexión' });
      return;
    }

    const { ObjectId } = require('mongodb');
    const id = req.params.id;

    if (!id || Array.isArray(id)) {
      res.status(400).json({ error: 'ID inválido' });
      return;
    }

    await db.collection('notas-entrega').deleteOne({ _id: new ObjectId(id) });
    res.json({ success: true });
  } catch (error) {
    console.error('Error eliminando nota de entrega:', error);
    res.status(500).json({ error: 'Error eliminando nota de entrega' });
  }
});

export default router;