import { Router, Request, Response } from 'express';
import { database } from '../config/database';

const router = Router();

router.get('/', async (req: Request, res: Response) => {
  try {
    const collection = database.getCollection('tasasGuardadas');
    const tasas = await collection.find().sort({ fechaCreacion: -1 }).toArray();
    res.json(tasas);
  } catch (error) {
    console.error('Error obteniendo tasas guardadas:', error);
    res.status(500).json({ error: 'Error al obtener tasas guardadas' });
  }
});

router.post('/', async (req: Request, res: Response) => {
  try {
    const { nombre, tasas, tipo } = req.body;
    
    if (!nombre || !tasas) {
      res.status(400).json({ error: 'Nombre y tasas son requeridos' });
      return;
    }

    const tasaDoc = {
      nombre,
      tasas: Object.entries(tasas).map(([fecha, valor]) => ({ fecha, valor })),
      tipo: tipo || 'actual',
      fechaCreacion: new Date(),
    };

    const collection = database.getCollection('tasasGuardadas');
    const result = await collection.insertOne(tasaDoc);
    res.json({ success: true, id: result.insertedId });
  } catch (error) {
    console.error('Error guardando tasas:', error);
    res.status(500).json({ error: 'Error al guardar tasas' });
  }
});

router.get('/:id', async (req: Request, res: Response) => {
  try {
    const { ObjectId } = await import('mongodb');
    const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const collection = database.getCollection('tasasGuardadas');
    const tasa = await collection.findOne({ _id: new ObjectId(id) });
    res.json(tasa);
  } catch (error) {
    console.error('Error obteniendo tasa:', error);
    res.status(500).json({ error: 'Error al obtener tasa' });
  }
});

router.delete('/:id', async (req: Request, res: Response) => {
  try {
    const { ObjectId } = await import('mongodb');
    const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const collection = database.getCollection('tasasGuardadas');
    await collection.deleteOne({ _id: new ObjectId(id) });
    res.json({ success: true });
  } catch (error) {
    console.error('Error eliminando tasas:', error);
    res.status(500).json({ error: 'Error al eliminar tasas guardadas' });
  }
});

export default router;