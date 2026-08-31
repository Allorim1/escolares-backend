import { Router, Request, Response } from 'express';
import { database } from '../config/database';
import { authenticateToken } from '../middlewares/auth.middleware';
import { InvProducto } from '../models';

const router = Router();

router.get('/', authenticateToken, async (req: Request, res: Response) => {
  try {
    const search = (req.query.q as string | undefined)?.trim() || '';
    const codgrupo1 = (req.query.codgrupo1 as string | undefined)?.trim() || '';
    const collection = database.getCollection<InvProducto>('inv_productos');

    const query: Record<string, unknown> = {};
    if (search) {
      const regex = new RegExp(search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      query.$or = [
        { codigo: regex },
        { nombre: regex },
      ];
    }
    if (codgrupo1) {
      query.codgrupo1 = codgrupo1;
    }

    const productos = await collection.find(query).limit(50).toArray();
    const mapped = productos.map((p) => ({
      _id: p._id,
      codigo: p.codigo || '',
      nombre: p.nombre || '',
      descrip: p.descrip || '',
      costo: p.costo ?? 0,
      precio: p.precio ?? 0,
      iva: p.iva ?? 0,
      stock: p.stock ?? 0,
      codgrupo1: p.codgrupo1 || '',
    }));

    res.json(mapped);
  } catch (error) {
    console.error('Error al obtener productos de inventario:', error);
    res.status(500).json({ error: 'Error al obtener productos de inventario' });
  }
});

export default router;
