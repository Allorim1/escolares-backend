import crypto from 'crypto';
import { Request, Response, Router } from 'express';
import rateLimit from 'express-rate-limit';
import { database } from '../config/database';
import { autenticarCaja, RequestCaja } from '../middlewares/autorizaciones.middleware';

/**
 * Pago móvil por QR: la caja de sellhub muestra en la pantalla del cliente un QR con
 * el enlace /pago/:token de la web. El cliente ve ahí el monto exacto y los datos del
 * pago móvil, paga desde su banco y escribe su cédula, teléfono, banco y referencia.
 * La caja consulta la solicitud cada pocos segundos, valida esos datos con el BDV
 * (desde sellhub: la clave del BDV no pasa por aquí) e informa el resultado, que el
 * cliente ve en su celular.
 *
 *   /api/pago-qr/caja/...           sellhub (cabecera x-api-key de la tienda)
 *     POST   /solicitudes                     { montoBs, cajaCodigo, destino }
 *     GET    /solicitudes/:token              estado y datos enviados por el cliente
 *     POST   /solicitudes/:token/estado       { estado: validando|validado|rechazado, mensaje }
 *     DELETE /solicitudes/:token              la caja ya no la usa
 *   /api/pago-qr/solicitudes/:token           público: lo que ve el cliente
 *   /api/pago-qr/solicitudes/:token/datos     público: { cedula, telefono, banco, referencia, fechaPago }
 *
 * Los datos del pagador solo se guardan mientras la caja los valida: al validarse,
 * rechazarse o cancelarse se borran. Cada solicitud vence a los VIGENCIA_MS y el
 * documento entero se borra solo una hora después (índice TTL).
 */

type EstadoPagoQr = 'esperando' | 'enviado' | 'validando' | 'validado' | 'rechazado' | 'cancelado';

interface DestinoPagoQr {
  banco: string;
  bancoNombre: string;
  telefono: string;
  rif: string;
  titular: string;
}

interface DatosPagador {
  cedula: string;
  telefono: string;
  banco: string;
  referencia: string;
  fechaPago: string;
}

interface SolicitudPagoQr {
  _id: string;
  tiendaId: string;
  cajaCodigo: string | null;
  montoBs: number;
  destino: DestinoPagoQr;
  estado: EstadoPagoQr;
  mensaje: string | null;
  datos: DatosPagador | null;
  intentos: number;
  creado: Date;
  actualizado: Date;
  expira: Date;
  /** Índice TTL: Mongo borra el documento a esta hora. */
  borrarEn: Date;
}

const COLECCION = 'pagos_qr';
const VIGENCIA_MS = 15 * 60_000;
const CONSERVAR_MS = 60 * 60_000;
const MAX_INTENTOS = 5;

const coleccion = () => database.getCollection<SolicitudPagoQr>(COLECCION);

let indicesListos = false;
async function asegurarIndices(): Promise<void> {
  if (indicesListos) return;
  await coleccion().createIndex({ borrarEn: 1 }, { expireAfterSeconds: 0 });
  await coleccion().createIndex({ tiendaId: 1, cajaCodigo: 1, estado: 1 });
  indicesListos = true;
}

const mensaje = (e: unknown) => (e instanceof Error ? e.message : 'Error inesperado');
const texto = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const vencida = (s: SolicitudPagoQr) => s.expira.getTime() < Date.now();
const tokenValido = (t: string) => /^[A-Za-z0-9_-]{16,64}$/.test(t);

/** Lo que puede ver cualquiera que tenga el enlace (nunca los datos del pagador). */
const vistaPublica = (s: SolicitudPagoQr) => ({
  montoBs: s.montoBs,
  destino: s.destino,
  estado: vencida(s) && !['validado', 'cancelado'].includes(s.estado) ? 'vencido' : s.estado,
  mensaje: s.mensaje,
  expiraEn: s.expira.toISOString(),
  intentosRestantes: Math.max(0, MAX_INTENTOS - s.intentos),
});

const hoyCaracas = (): string => new Date().toLocaleDateString('en-CA', { timeZone: 'America/Caracas' });

function leerDatosPagador(body: Record<string, unknown>): DatosPagador {
  const cedula = texto(body.cedula, 12).toUpperCase().replace(/[^VEJP0-9]/g, '');
  const telefono = texto(body.telefono, 14).replace(/\D/g, '');
  const banco = texto(body.banco, 4);
  const referencia = texto(body.referencia, 20).replace(/\D/g, '');
  const fechaPago = texto(body.fechaPago, 10);
  if (!/^[VEJP]\d{5,9}$/.test(cedula)) throw new Error('Revisa la cédula: letra y números, por ejemplo V12345678');
  if (!/^04\d{9}$/.test(telefono)) throw new Error('El teléfono debe tener 11 dígitos, por ejemplo 04141234567');
  if (!/^\d{4}$/.test(banco)) throw new Error('Selecciona el banco desde el que pagaste');
  if (!/^\d{4,20}$/.test(referencia)) throw new Error('Escribe el número de referencia del pago (solo números)');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fechaPago)) throw new Error('Indica la fecha del pago');
  const hoy = hoyCaracas();
  const anteayer = new Date(Date.now() - 2 * 86_400_000).toLocaleDateString('en-CA', { timeZone: 'America/Caracas' });
  if (fechaPago > hoy || fechaPago < anteayer) throw new Error('La fecha del pago debe ser de hoy o de los dos días anteriores');
  return { cedula, telefono, banco, referencia, fechaPago };
}

// ---------------------------------------------------------------- caja (sellhub)

const caja = Router();
caja.use(autenticarCaja);

const tiendaDe = (req: Request) => String((req as RequestCaja).tienda?._id ?? '');

caja.post('/solicitudes', async (req: Request, res: Response) => {
  try {
    await asegurarIndices();
    const body = (req.body ?? {}) as Record<string, unknown>;
    const montoBs = Math.round(Number(body.montoBs) * 100) / 100;
    if (!Number.isFinite(montoBs) || montoBs <= 0 || montoBs > 1_000_000_000) {
      res.status(400).json({ message: 'Monto inválido' });
      return;
    }
    const d = (body.destino ?? {}) as Record<string, unknown>;
    const destino: DestinoPagoQr = {
      banco: texto(d.banco, 4),
      bancoNombre: texto(d.bancoNombre, 60),
      telefono: texto(d.telefono, 14),
      rif: texto(d.rif, 15),
      titular: texto(d.titular, 80),
    };
    if (!destino.banco || !destino.telefono || !destino.rif) {
      res.status(400).json({ message: 'Faltan los datos del pago móvil de la tienda' });
      return;
    }
    const tiendaId = tiendaDe(req);
    const cajaCodigo = texto(body.cajaCodigo, 20) || null;
    const ahora = new Date();
    // Una caja cobra una venta a la vez: las solicitudes anteriores de esa caja que
    // aún esperaban al cliente dejan de servir.
    await coleccion().updateMany(
      { tiendaId, cajaCodigo, estado: { $in: ['esperando', 'enviado', 'rechazado'] } },
      { $set: { estado: 'cancelado', datos: null, mensaje: 'La caja generó otro cobro', actualizado: ahora } }
    );
    const expira = new Date(ahora.getTime() + VIGENCIA_MS);
    const solicitud: SolicitudPagoQr = {
      _id: crypto.randomBytes(16).toString('base64url'),
      tiendaId,
      cajaCodigo,
      montoBs,
      destino,
      estado: 'esperando',
      mensaje: null,
      datos: null,
      intentos: 0,
      creado: ahora,
      actualizado: ahora,
      expira,
      borrarEn: new Date(expira.getTime() + CONSERVAR_MS),
    };
    await coleccion().insertOne(solicitud);
    res.status(201).json({ token: solicitud._id, expiraEn: expira.toISOString() });
  } catch (e) {
    res.status(500).json({ message: mensaje(e) });
  }
});

caja.get('/solicitudes/:token', async (req: Request, res: Response) => {
  try {
    const s = await coleccion().findOne({ _id: req.params.token, tiendaId: tiendaDe(req) });
    if (!s) {
      res.status(404).json({ message: 'La solicitud de pago no existe o ya venció' });
      return;
    }
    res.json({ ...vistaPublica(s), datos: s.estado === 'enviado' || s.estado === 'validando' ? s.datos : null });
  } catch (e) {
    res.status(500).json({ message: mensaje(e) });
  }
});

caja.post('/solicitudes/:token/estado', async (req: Request, res: Response) => {
  try {
    const estado = texto(req.body?.estado, 20) as EstadoPagoQr;
    if (!['validando', 'validado', 'rechazado'].includes(estado)) {
      res.status(400).json({ message: 'Estado inválido' });
      return;
    }
    const cambios: Partial<SolicitudPagoQr> = { estado, mensaje: texto(req.body?.mensaje, 200) || null, actualizado: new Date() };
    // Ya validado o rechazado, los datos del pagador no hacen falta aquí.
    if (estado !== 'validando') cambios.datos = null;
    const r = await coleccion().updateOne({ _id: req.params.token, tiendaId: tiendaDe(req), estado: { $ne: 'cancelado' } }, { $set: cambios });
    if (r.matchedCount === 0) {
      res.status(404).json({ message: 'La solicitud de pago no existe o fue cancelada' });
      return;
    }
    res.status(204).end();
  } catch (e) {
    res.status(500).json({ message: mensaje(e) });
  }
});

caja.delete('/solicitudes/:token', async (req: Request, res: Response) => {
  try {
    await coleccion().updateOne(
      { _id: req.params.token, tiendaId: tiendaDe(req), estado: { $ne: 'validado' } },
      { $set: { estado: 'cancelado', datos: null, mensaje: 'La caja canceló este cobro', actualizado: new Date() } }
    );
    res.status(204).end();
  } catch (e) {
    res.status(500).json({ message: mensaje(e) });
  }
});

// ---------------------------------------------------------------- público (celular del cliente)

const limite = (n: number) =>
  rateLimit({
    windowMs: 15 * 60_000,
    limit: n,
    standardHeaders: true,
    legacyHeaders: false,
    message: { message: 'Demasiadas solicitudes. Intenta en unos minutos o pide ayuda en la caja.' },
  });

const router = Router();
router.use('/caja', caja);

// El celular consulta el estado cada pocos segundos mientras espera la validación.
router.get('/solicitudes/:token', limite(600), async (req: Request, res: Response) => {
  try {
    const token = String(req.params.token);
    const s = tokenValido(token) ? await coleccion().findOne({ _id: token }) : null;
    if (!s) {
      res.status(404).json({ message: 'Este enlace de pago no existe o ya venció' });
      return;
    }
    res.json(vistaPublica(s));
  } catch {
    res.status(500).json({ message: 'No se pudo consultar el pago' });
  }
});

router.post('/solicitudes/:token/datos', limite(60), async (req: Request, res: Response) => {
  try {
    const token = String(req.params.token);
    const s = tokenValido(token) ? await coleccion().findOne({ _id: token }) : null;
    if (!s) {
      res.status(404).json({ message: 'Este enlace de pago no existe o ya venció' });
      return;
    }
    if (vencida(s)) {
      res.status(410).json({ message: 'Este enlace de pago venció. Pide en la caja que generen otro.' });
      return;
    }
    if (!['esperando', 'rechazado'].includes(s.estado)) {
      res.status(409).json({ message: s.estado === 'cancelado' ? 'Este cobro ya no está activo' : 'Los datos de este pago ya se recibieron' });
      return;
    }
    if (s.intentos >= MAX_INTENTOS) {
      res.status(429).json({ message: 'Se agotaron los intentos. Muestra tu comprobante en la caja.' });
      return;
    }
    let datos: DatosPagador;
    try {
      datos = leerDatosPagador((req.body ?? {}) as Record<string, unknown>);
    } catch (e) {
      res.status(400).json({ message: mensaje(e) });
      return;
    }
    // Condicionado al estado leído: si dos envíos llegan a la vez, solo uno pasa.
    const r = await coleccion().updateOne(
      { _id: token, estado: s.estado, intentos: s.intentos },
      { $set: { estado: 'enviado', datos, mensaje: null, actualizado: new Date() }, $inc: { intentos: 1 } }
    );
    if (r.matchedCount === 0) {
      res.status(409).json({ message: 'Los datos de este pago ya se recibieron' });
      return;
    }
    res.status(202).json({ estado: 'enviado' });
  } catch {
    res.status(500).json({ message: 'No se pudieron enviar los datos del pago' });
  }
});

export default router;
