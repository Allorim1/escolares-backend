import { Router, Request, Response } from 'express';
import { database } from '../config/database';

const router = Router();

router.get('/', async (req: Request, res: Response) => {
  try {
    const collection = database.getCollection('tasasGuardadas');
    const tasas = await collection.find({}).sort({ fechaCreacion: -1 }).toArray();
    const limpias = tasas.map(t => ({ ...t, _id: t._id.toString() }));
    res.json(limpias);
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

    let tasasNormalizadas: { fecha: string; valor: number }[] = [];
    if (Array.isArray(tasas)) {
      tasasNormalizadas = tasas.map((t: any) => ({
        fecha: t.fecha || t[0],
        valor: Number(t.valor || t[1]),
      }));
    } else if (typeof tasas === 'object' && tasas !== null) {
      tasasNormalizadas = Object.entries(tasas).map(([fecha, valor]) => ({ fecha, valor: Number(valor) }));
    }

    const tasaDoc = {
      nombre,
      tasas: tasasNormalizadas,
      tipo: tipo || 'actual',
      fechaCreacion: new Date(),
    };

    const collection = database.getCollection('tasasGuardadas');
    const result = await collection.insertOne(tasaDoc);
    res.json({ success: true, id: result.insertedId.toString() });
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
    if (!tasa) {
      res.status(404).json({ error: 'Tasa no encontrada' });
      return;
    }
    res.json({ ...tasa, _id: tasa._id.toString() });
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

router.put('/:id', async (req: Request, res: Response) => {
  try {
    const { ObjectId } = await import('mongodb');
    const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const { nombre, tasas, tipo } = req.body;
    const collection = database.getCollection('tasasGuardadas');
    const updateData: any = {
      nombre: nombre || '',
      tipo: tipo || 'actual',
    };
    if (tasas) {
      if (Array.isArray(tasas)) {
        updateData.tasas = tasas.map((t: any) => ({
          fecha: t.fecha || t[0],
          valor: Number(t.valor || t[1]),
        }));
      } else if (typeof tasas === 'object' && tasas !== null) {
        updateData.tasas = Object.entries(tasas).map(([fecha, valor]) => ({ fecha, valor: Number(valor) }));
      }
    }
    await collection.updateOne({ _id: new ObjectId(id) }, { $set: updateData });
    res.json({ success: true });
  } catch (error) {
    console.error('Error actualizando tasas:', error);
    res.status(500).json({ error: 'Error al actualizar tasas guardadas' });
  }
});

export default router;