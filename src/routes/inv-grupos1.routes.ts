import { Router, Request, Response } from 'express';
import { database } from '../config/database';

const router = Router();

router.get('/', async (req: Request, res: Response) => {
  try {
    const search = (req.query.q as string | undefined)?.trim() || '';
    const collection = database.getCollection('inv_grupos1');

    const query: Record<string, unknown> = { borrado: 0 };
    if (search) {
      const regex = new RegExp(search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      query.$or = [
        { codigo: regex },
        { nombre: regex },
      ];
    }

    const grupos = await collection.find(query).limit(50).toArray();
    const mapped = grupos.map((g: any) => ({
      codigo: g.codigo || '',
      nombre: g.nombre || '',
    }));

    res.json(mapped);
  } catch (error) {
    console.error('Error al obtener grupos:', error);
    res.status(500).json({ error: 'Error al obtener grupos' });
  }
});

export default router;
