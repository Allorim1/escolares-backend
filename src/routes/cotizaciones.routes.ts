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

    const cotizaciones = await db.collection('cotizaciones')
      .find({})
      .sort({ fecha: -1 })
      .toArray();

    res.json(cotizaciones);
  } catch (error) {
    console.error('Error obteniendo cotizaciones:', error);
    res.status(500).json({ error: 'Error obteniendo cotizaciones' });
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
    const cotizacion = await db.collection('cotizaciones').findOne({ _id: new ObjectId(req.params.id) });

    if (!cotizacion) {
      res.status(404).json({ error: 'Cotización no encontrada' });
      return;
    }

    res.json(cotizacion);
  } catch (error) {
    console.error('Error obteniendo cotización:', error);
    res.status(500).json({ error: 'Error obteniendo cotización' });
  }
});

router.post('/', authenticateToken, async (req: Request, res: Response) => {
  try {
    const db = database.db;
    if (!db) {
      res.status(500).json({ error: 'Error de conexión' });
      return;
    }

    const cotizacion = req.body;
    cotizacion.fecha = new Date(cotizacion.fecha);

    const result = await db.collection('cotizaciones').insertOne(cotizacion);
    res.json({ success: true, _id: result.insertedId });
  } catch (error) {
    console.error('Error creando cotización:', error);
    res.status(500).json({ error: 'Error creando cotización' });
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
    const cotizacion = req.body;

    if (!id || Array.isArray(id)) {
      res.status(400).json({ error: 'ID inválido' });
      return;
    }

    await db.collection('cotizaciones').updateOne(
      { _id: new ObjectId(id) },
      { $set: cotizacion }
    );

    res.json({ success: true });
  } catch (error) {
    console.error('Error actualizando cotización:', error);
    res.status(500).json({ error: 'Error actualizando cotización' });
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

    await db.collection('cotizaciones').deleteOne({ _id: new ObjectId(id) });
    res.json({ success: true });
  } catch (error) {
    console.error('Error eliminando cotización:', error);
    res.status(500).json({ error: 'Error eliminando cotización' });
  }
});

export default router;