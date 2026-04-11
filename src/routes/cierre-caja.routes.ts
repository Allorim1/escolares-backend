import { Router, Request, Response } from 'express';
import { database } from '../config/database';
import { authenticateToken } from '../middlewares/auth.middleware';
import { ObjectId } from 'mongodb';

const router = Router();

interface CierreCaja {
  _id?: ObjectId;
  fecha: Date;
  usuario: string;
  saldoInicial: number;
  cajas: Record<string, Record<string, number>>;
  totalGastos: number;
  saldoFinal: number;
  observaciones: string;
  diferencia?: number;
}

router.get('/', authenticateToken, async (req: Request, res: Response) => {
  try {
    const db = database.db;
    if (!db) {
      res.status(500).json({ error: 'Error de conexión' });
      return;
    }

    const fecha = req.query.fecha as string;
    let query: any = {};

    if (fecha) {
      const fechaDate = new Date(fecha + 'T00:00:00');
      const fechaSig = new Date(fecha + 'T23:59:59.999');
      query.fecha = { $gte: fechaDate, $lte: fechaSig };
    }

    const cierres = await db.collection('cierre_caja')
      .find(query)
      .sort({ fecha: -1 })
      .toArray();

    res.json(cierres);
  } catch (error) {
    console.error('Error obteniendo cierres:', error);
    res.status(500).json({ error: 'Error obteniendo cierres' });
  }
});

router.post('/', authenticateToken, async (req: Request, res: Response) => {
  try {
    const { saldoInicial, cajas, totalGastos, saldoFinal, observaciones, diferencia } = req.body;
    const username = req.user?.username || req.user?.nombre || 'Usuario';

    if (saldoInicial === undefined || !cajas) {
      res.status(400).json({ error: 'Faltan datos requeridos' });
      return;
    }

    const db = database.db;
    if (!db) {
      res.status(500).json({ error: 'Error de conexión' });
      return;
    }

    const cierre: CierreCaja = {
      fecha: new Date(),
      usuario: username,
      saldoInicial,
      cajas,
      totalGastos: totalGastos || 0,
      saldoFinal,
      observaciones: observaciones || '',
      diferencia
    };

    await db.collection('cierre_caja').insertOne(cierre);
    res.json({ success: true, cierre });
  } catch (error) {
    console.error('Error guardando cierre:', error);
    res.status(500).json({ error: 'Error guardando cierre' });
  }
});

router.delete('/:id', authenticateToken, async (req: Request, res: Response) => {
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

    await db.collection('cierre_caja').deleteOne({ _id: new ObjectId(req.params.id) });
    res.json({ success: true });
  } catch (error) {
    console.error('Error eliminando cierre:', error);
    res.status(500).json({ error: 'Error eliminando cierre' });
  }
});

export default router;