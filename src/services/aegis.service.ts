import crypto from 'crypto';
import { database } from '../config/database';

/**
 * Aegis (versión comercial de sellhub): licencias revocables y reportes de errores.
 *
 * - Cada instalación de Aegis consulta cada hora si su licencia sigue vigente
 *   (POST /api/aegis/licencia/verificar). La respuesta va FIRMADA con AEGIS_FIRMA_PRIVADA
 *   (Ed25519, PKCS8 DER en base64): Aegis trae la clave pública y no acepta respuestas
 *   sin firma, así nadie puede poner un servidor falso que diga "vigente".
 * - Las licencias las firma Aegis Gestión con OTRA clave (la privada solo está en la PC del
 *   vendedor). Aquí solo se comprueba su firma con la pública, para registrarlas.
 * - Revocar marca la licencia (o la instalación entera) y la siguiente consulta la bloquea.
 * - Los errores se agrupan por huella (mismo mensaje y pila en la misma versión): un error
 *   que se repite mil veces es una sola fila con su contador.
 */

/** Misma clave pública que aegis/src/types/licencia.ts (CLAVE_PUBLICA_LICENCIAS). */
const CLAVE_PUBLICA_LICENCIAS = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAWPGw3ida02+gbg/D++REBwc/Dwx40GNpbg+NqjEz6PM=
-----END PUBLIC KEY-----`;

export class ErrorAegis extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export interface LicenciaAegis {
  _id: string;
  instalacion: string;
  cliente: string;
  rif: string;
  plan: string;
  modulos: string[];
  maxEquipos: number;
  emitida: string;
  vence: string;
  revocada: boolean;
  revocadaEn: Date | null;
  motivo: string;
  registradaEn: Date;
  ultimaVerificacion: Date | null;
  ultimaVersion: string;
  ultimoEquipo: string;
}

export interface InstalacionAegis {
  _id: string;
  revocada: boolean;
  revocadaEn: Date | null;
  motivo: string;
}

export interface ErrorReportado {
  _id: string;
  huella: string;
  instalacion: string;
  cliente: string;
  version: string;
  proceso: string;
  mensaje: string;
  stack: string;
  contexto: string;
  equipos: string[];
  veces: number;
  primeraVez: Date;
  ultimaVez: Date;
  resuelto: boolean;
}

const licencias = () => database.getCollection<LicenciaAegis>('aegis_licencias');
const instalaciones = () => database.getCollection<InstalacionAegis>('aegis_instalaciones');
const errores = () => database.getCollection<ErrorReportado>('aegis_errores');

const texto = (v: unknown, max = 300): string => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const RE_INSTALACION = /^AEG-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/;
const deB64url = (t: string): Buffer => Buffer.from(t.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
const aB64url = (b: Buffer): string => b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

// ---------------------------------------------------------------- licencias

interface ContenidoLicencia {
  v: number;
  id: string;
  cliente: string;
  rif: string;
  instalacion: string;
  plan: string;
  modulos: string[];
  maxEquipos: number;
  emitida: string;
  vence: string;
}

/** Comprueba la firma de una licencia "AEGIS1.<datos>.<firma>" y devuelve su contenido. */
export function leerLicencia(textoLicencia: unknown): ContenidoLicencia {
  const partes = String(textoLicencia ?? '').replace(/\s+/g, '').split('.');
  if (partes.length !== 3 || partes[0] !== 'AEGIS1') throw new ErrorAegis(400, 'No es una licencia de Aegis');
  const datos = deB64url(partes[1]);
  if (!crypto.verify(null, datos, crypto.createPublicKey(CLAVE_PUBLICA_LICENCIAS), deB64url(partes[2]))) {
    throw new ErrorAegis(400, 'La firma de la licencia no es válida');
  }
  try {
    return JSON.parse(datos.toString('utf8')) as ContenidoLicencia;
  } catch {
    throw new ErrorAegis(400, 'La licencia está dañada');
  }
}

/** Registra (o actualiza) una licencia emitida. Idempotente. */
export async function registrarLicencia(textoLicencia: unknown): Promise<LicenciaAegis> {
  const c = leerLicencia(textoLicencia);
  const campos = {
    instalacion: c.instalacion,
    cliente: texto(c.cliente),
    rif: texto(c.rif, 30),
    plan: texto(c.plan, 40),
    modulos: Array.isArray(c.modulos) ? c.modulos.map(String).slice(0, 40) : [],
    maxEquipos: Number(c.maxEquipos) || 0,
    emitida: texto(c.emitida, 10),
    vence: texto(c.vence, 10),
  };
  await licencias().updateOne(
    { _id: c.id },
    {
      $set: campos,
      $setOnInsert: {
        revocada: false,
        revocadaEn: null,
        motivo: '',
        registradaEn: new Date(),
        ultimaVerificacion: null,
        ultimaVersion: '',
        ultimoEquipo: '',
      },
    },
    { upsert: true }
  );
  return (await licencias().findOne({ _id: c.id }))!;
}

export async function listarLicencias(): Promise<LicenciaAegis[]> {
  return licencias().find().sort({ registradaEn: -1 }).toArray();
}

export async function listarInstalacionesRevocadas(): Promise<InstalacionAegis[]> {
  return instalaciones().find({ revocada: true }).toArray();
}

export async function revocarLicencia(id: string, revocar: boolean, motivo: unknown): Promise<LicenciaAegis> {
  const r = await licencias().findOneAndUpdate(
    { _id: id },
    { $set: { revocada: revocar, revocadaEn: revocar ? new Date() : null, motivo: revocar ? texto(motivo) : '' } },
    { returnDocument: 'after' }
  );
  if (!r) throw new ErrorAegis(404, 'La licencia no está registrada en el servidor');
  return r;
}

/** Revoca TODAS las licencias de una instalación, también las que se emitan después. */
export async function revocarInstalacion(instalacion: string, revocar: boolean, motivo: unknown): Promise<InstalacionAegis> {
  if (!RE_INSTALACION.test(instalacion)) throw new ErrorAegis(400, 'Código de instalación inválido');
  await instalaciones().updateOne(
    { _id: instalacion },
    { $set: { revocada: revocar, revocadaEn: revocar ? new Date() : null, motivo: revocar ? texto(motivo) : '' } },
    { upsert: true }
  );
  return (await instalaciones().findOne({ _id: instalacion }))!;
}

// ---------------------------------------------------------------- verificación (la llama Aegis)

let clavePrivada: crypto.KeyObject | null | undefined;

function claveFirma(): crypto.KeyObject {
  if (clavePrivada === undefined) {
    const base64 = (process.env.AEGIS_FIRMA_PRIVADA || '').trim();
    try {
      clavePrivada = base64 ? crypto.createPrivateKey({ key: Buffer.from(base64, 'base64'), format: 'der', type: 'pkcs8' }) : null;
    } catch {
      clavePrivada = null;
    }
  }
  if (!clavePrivada) throw new ErrorAegis(503, 'El servidor de licencias no está configurado');
  return clavePrivada;
}

export interface RespuestaFirmada {
  datos: string;
  firma: string;
}

/**
 * Body: { licencia (texto completo), instalacion, nonce, version, equipo }.
 * Responde { datos, firma }: datos = base64url de
 * { instalacion, licenciaId, estado: 'vigente'|'revocada', motivo, nonce, fecha }.
 */
export async function verificarLicencia(body: Record<string, unknown>): Promise<RespuestaFirmada> {
  const instalacion = texto(body.instalacion, 30);
  const nonce = texto(body.nonce, 64);
  if (!RE_INSTALACION.test(instalacion)) throw new ErrorAegis(400, 'Código de instalación inválido');
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(nonce)) throw new ErrorAegis(400, 'Falta el nonce');
  const firma = claveFirma();

  const contenido = leerLicencia(body.licencia);
  if (contenido.instalacion !== instalacion && contenido.instalacion !== '*') {
    throw new ErrorAegis(400, 'La licencia es de otra instalación');
  }
  const registrada = await registrarLicencia(body.licencia);
  await licencias().updateOne(
    { _id: registrada._id },
    { $set: { ultimaVerificacion: new Date(), ultimaVersion: texto(body.version, 30), ultimoEquipo: texto(body.equipo, 80) } }
  );
  const inst = await instalaciones().findOne({ _id: instalacion });

  const revocada = registrada.revocada || inst?.revocada === true;
  const respuesta = {
    instalacion,
    licenciaId: registrada._id,
    estado: revocada ? 'revocada' : 'vigente',
    motivo: revocada ? (registrada.revocada ? registrada.motivo : inst?.motivo) || '' : '',
    nonce,
    fecha: new Date().toISOString(),
  };
  const datos = Buffer.from(JSON.stringify(respuesta), 'utf8');
  return { datos: aB64url(datos), firma: aB64url(crypto.sign(null, datos, firma)) };
}

// ---------------------------------------------------------------- errores

const MAX_REPORTES = 20;

/** Body: { instalacion, cliente?, version, equipo, reportes: [{ proceso, mensaje, stack, contexto }] }. */
export async function recibirErrores(body: Record<string, unknown>): Promise<{ recibidos: number }> {
  const instalacion = texto(body.instalacion, 30);
  if (instalacion && !RE_INSTALACION.test(instalacion)) throw new ErrorAegis(400, 'Código de instalación inválido');
  const version = texto(body.version, 30);
  const equipo = texto(body.equipo, 80);
  const cliente = texto(body.cliente, 150);
  const reportes = Array.isArray(body.reportes) ? body.reportes.slice(0, MAX_REPORTES) : [];
  const ahora = new Date();
  let recibidos = 0;
  for (const crudo of reportes) {
    const r = (crudo ?? {}) as Record<string, unknown>;
    const mensaje = texto(r.mensaje, 2000);
    if (!mensaje) continue;
    const stack = texto(r.stack, 8000);
    const proceso = texto(r.proceso, 20) || 'desconocido';
    // Misma huella = mismo error: mensaje + primeras líneas de la pila + versión + instalación.
    const huella = crypto
      .createHash('sha1')
      .update([instalacion, version, proceso, mensaje, stack.split('\n').slice(0, 4).join('\n')].join('|'))
      .digest('hex');
    await errores().updateOne(
      { _id: huella },
      {
        $set: { ultimaVez: ahora, contexto: texto(r.contexto, 2000), resuelto: false, cliente },
        $inc: { veces: 1 },
        $addToSet: { equipos: equipo },
        $setOnInsert: { huella, instalacion, version, proceso, mensaje, stack, primeraVez: ahora },
      },
      { upsert: true }
    );
    recibidos++;
  }
  return { recibidos };
}

export async function listarErrores(filtro: { instalacion?: string; incluirResueltos?: boolean; limite?: number }): Promise<ErrorReportado[]> {
  const q: Record<string, unknown> = {};
  if (filtro.instalacion) q.instalacion = filtro.instalacion;
  if (!filtro.incluirResueltos) q.resuelto = { $ne: true };
  return errores()
    .find(q)
    .sort({ ultimaVez: -1 })
    .limit(Math.min(Math.max(filtro.limite || 200, 1), 1000))
    .toArray();
}

export async function marcarErrorResuelto(id: string, resuelto: boolean): Promise<void> {
  const r = await errores().updateOne({ _id: id }, { $set: { resuelto } });
  if (r.matchedCount === 0) throw new ErrorAegis(404, 'El error no existe');
}
