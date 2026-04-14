import { Router, Request, Response } from 'express';
import { database } from '../config/database';
import { authenticateToken } from '../middlewares/auth.middleware';
import { ObjectId } from 'mongodb';
import nodemailer from 'nodemailer';

const router = Router();

const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST || 'smtp.gmail.com',
  port: parseInt(process.env.SMTP_PORT || '587'),
  secure: false,
  auth: {
    user: process.env.SMTP_USER || '',
    pass: process.env.SMTP_PASS || ''
  }
});

const emailsCierreCaja = (process.env.EMAILS_CIERRE_CAJA || '').split(',').filter(e => e.trim());

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
    
    if (emailsCierreCaja.length > 0) {
      const detalleCajas = Object.entries(cajas).map(([cajaId, metodos]) => {
        const entries = Object.entries(metodos as Record<string, number>);
        const detalle = entries
          .filter(([_, v]) => v > 0)
          .map(([k, v]) => `${k}: ${v.toFixed(2)}`)
          .join(', ');
        return `${cajaId}: ${detalle}`;
      }).join('\n');

      const htmlContent = `
        <h2>Cierre de Caja</h2>
        <p><strong>Usuario:</strong> ${username}</p>
        <p><strong>Fecha:</strong> ${new Date().toLocaleString('es-VE')}</p>
        <p><strong>Saldo Inicial:</strong> Bs. ${saldoInicial.toFixed(2)}</p>
        <p><strong>Total Gastos:</strong> Bs. ${(totalGastos || 0).toFixed(2)}</p>
        <p><strong>Saldo Final:</strong> Bs. ${saldoFinal.toFixed(2)}</p>
        <p><strong>Diferencia:</strong> Bs. ${(diferencia || 0).toFixed(2)}</p>
        <h3>Detalle por Caja:</h3>
        <pre style="background:#f5f5f5;padding:10px;border-radius:4px;">${detalleCajas}</pre>
        ${observaciones ? `<p><strong>Observaciones:</strong> ${observaciones}</p>` : ''}
      `;

      try {
        await transporter.sendMail({
          from: process.env.SMTP_FROM || 'noreply@escolares.com',
          to: emailsCierreCaja.join(','),
          subject: `Cierre de Caja - ${new Date().toLocaleDateString('es-VE')}`,
          html: htmlContent
        });
        console.log('Correo de cierre de caja enviado a:', emailsCierreCaja);
      } catch (emailError) {
        console.error('Error enviando correo de cierre:', emailError);
      }
    }
    
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

    const id = req.params.id;
    if (!id || Array.isArray(id)) {
      res.status(400).json({ error: 'ID inválido' });
      return;
    }

    await db.collection('cierre_caja').deleteOne({ _id: new ObjectId(id) });
    res.json({ success: true });
  } catch (error) {
    console.error('Error eliminando cierre:', error);
    res.status(500).json({ error: 'Error eliminando cierre' });
  }
});

export default router;