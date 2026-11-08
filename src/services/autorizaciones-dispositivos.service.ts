import crypto from 'crypto';
import { Request } from 'express';
import { database } from '../config/database';
import { jwtConfig } from '../config/jwt';
import { createSessionRecord } from '../middlewares/session.middleware';
import { User } from '../models';
import { emitirADispositivo, sacarDispositivoDeSalaUsuario } from './autorizaciones-socket.service';
import {
  cerrarSesionesEscolares,
  coleccionSecundarios,
  DispositivoSecundario,
  ErrorAutorizaciones,
  MAX_SECUNDARIOS,
  secundarioPorDispositivo,
  vinculoPorDispositivo,
  VinculoAutorizaciones,
} from './autorizaciones-vinculos.service';

/**
 * Dispositivos vinculados por QR (como los "dispositivos vinculados" de WhatsApp).
 *
 *   1. El celular principal (el vinculado desde sellhub) abre Perfil y muestra un QR que
 *      dura QR_TTL_MS; la app pide otro solo cuando vence.
 *   2. El celular nuevo, desde la pantalla de inicio de sesión, lo escanea (o escribe el
 *      código corto que va debajo) sin estar logueado: POST /api/autorizaciones/qr/escanear.
 *   3. El principal ve "¿Vincular <nombre>?" y acepta o rechaza.
 *   4. Si acepta, el backend le abre al nuevo una sesión de la misma cuenta de escolares y
 *      lo registra como secundario; el nuevo la recoge con su `espera` (solo él la conoce).
 *
 * Los pendientes viven en memoria, igual que los códigos de vinculación con sellhub.
 */

const QR_TTL_MS = 60_000;
/** Tiempo para que el principal conteste una vez escaneado (y para recoger la sesión). */
const RESPUESTA_TTL_MS = 2 * 60_000;
const PREFIJO_QR = 'escolarespro:vincular:';
/** Sin 0/O ni 1/I/L para que el código se pueda dictar y escribir sin confusiones. */
const ALFABETO_CODIGO = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

type EstadoQr = 'esperando' | 'escaneado' | 'aceptado' | 'rechazado';

interface QrPendiente {
  token: string;
  codigo: string;
  sellhubUsuarioId: string;
  escolaresUserId: string;
  principalDispositivoId: string;
  estado: EstadoQr;
  expiraEn: number;
  candidato?: { dispositivoId: string; nombre: string; espera: string };
  sesion?: { accessToken: string; refreshToken: string; nombre: string };
}

const porToken = new Map<string, QrPendiente>();

function purgar(): void {
  const ahora = Date.now();
  for (const [token, p] of porToken) if (p.expiraEn < ahora) porToken.delete(token);
}

function codigoCorto(): string {
  let codigo = '';
  for (let i = 0; i < 8; i++) codigo += ALFABETO_CODIGO[crypto.randomInt(ALFABETO_CODIGO.length)];
  return codigo;
}

const normalizarCodigo = (texto: string) => texto.toUpperCase().replace(/[^A-Z0-9]/g, '');

function buscarPorQrOCodigo(texto: string): QrPendiente | undefined {
  purgar();
  const limpio = texto.trim();
  if (limpio.startsWith(PREFIJO_QR)) return porToken.get(limpio.slice(PREFIJO_QR.length));
  const codigo = normalizarCodigo(limpio);
  if (codigo.length !== 8) return undefined;
  for (const p of porToken.values()) if (p.codigo === codigo) return p;
  return undefined;
}

/** El QR (o la espera) le pertenece a este principal y sigue vivo. */
function pendienteDe(vinculo: VinculoAutorizaciones, token: string): QrPendiente {
  purgar();
  const p = porToken.get(token);
  if (!p || p.sellhubUsuarioId !== vinculo._id) throw new ErrorAutorizaciones(404, 'El QR venció. Genera otro.');
  return p;
}

function exigirPrincipal(vinculo: VinculoAutorizaciones, dispositivoId: string): void {
  if (vinculo.dispositivoId !== dispositivoId) {
    throw new ErrorAutorizaciones(403, 'Solo el celular principal puede vincular o retirar dispositivos');
  }
}

// ---------------------------------------------------------------- principal

export async function crearQr(vinculo: VinculoAutorizaciones, dispositivoId: string) {
  exigirPrincipal(vinculo, dispositivoId);
  const cuantos = await (await coleccionSecundarios()).countDocuments({ sellhubUsuarioId: vinculo._id });
  if (cuantos >= MAX_SECUNDARIOS) {
    throw new ErrorAutorizaciones(409, `Ya tienes ${MAX_SECUNDARIOS} dispositivos vinculados. Retira uno para agregar otro.`);
  }

  // Un solo QR vivo por usuario: pedir otro invalida el anterior (si nadie lo escaneó todavía).
  purgar();
  for (const [token, p] of porToken) {
    if (p.sellhubUsuarioId === vinculo._id && p.estado === 'esperando') porToken.delete(token);
  }

  const token = crypto.randomBytes(24).toString('base64url');
  let codigo: string;
  do codigo = codigoCorto();
  while ([...porToken.values()].some((p) => p.codigo === codigo));

  const pendiente: QrPendiente = {
    token,
    codigo,
    sellhubUsuarioId: vinculo._id,
    escolaresUserId: vinculo.escolaresUserId,
    principalDispositivoId: vinculo.dispositivoId,
    estado: 'esperando',
    expiraEn: Date.now() + QR_TTL_MS,
  };
  porToken.set(token, pendiente);
  return { token, qr: PREFIJO_QR + token, codigo, expiraEn: new Date(pendiente.expiraEn) };
}

export function estadoQr(vinculo: VinculoAutorizaciones, token: string) {
  purgar();
  const p = porToken.get(token);
  if (!p || p.sellhubUsuarioId !== vinculo._id) return { estado: 'vencido' as const };
  return { estado: p.estado, candidatoNombre: p.candidato?.nombre ?? null, expiraEn: new Date(p.expiraEn) };
}

export async function responderQr(vinculo: VinculoAutorizaciones, dispositivoId: string, token: string, aceptar: boolean, req: Request) {
  exigirPrincipal(vinculo, dispositivoId);
  const p = pendienteDe(vinculo, token);
  if (p.estado !== 'escaneado' || !p.candidato) throw new ErrorAutorizaciones(409, 'Nadie ha escaneado este QR todavía');

  if (!aceptar) {
    p.estado = 'rechazado';
    return { estado: p.estado };
  }

  const secundarios = await coleccionSecundarios();
  const yaEra = await secundarios.findOne({ _id: p.candidato.dispositivoId });
  const cuantos = await secundarios.countDocuments({ sellhubUsuarioId: vinculo._id });
  if (!yaEra && cuantos >= MAX_SECUNDARIOS) {
    throw new ErrorAutorizaciones(409, `Ya tienes ${MAX_SECUNDARIOS} dispositivos vinculados. Retira uno para agregar otro.`);
  }

  const sesion = await abrirSesionEscolares(vinculo.escolaresUserId, req);
  if (yaEra) await cerrarSesionesEscolares([yaEra.sessionId], 'dispositivo_revinculado');
  const ahora = new Date();
  await secundarios.replaceOne(
    { _id: p.candidato.dispositivoId },
    {
      id: yaEra?.id ?? crypto.randomUUID(),
      sellhubUsuarioId: vinculo._id,
      escolaresUserId: vinculo.escolaresUserId,
      dispositivoNombre: p.candidato.nombre,
      pushTokens: [],
      sessionId: sesion.sessionId,
      vinculadoEn: ahora,
      ultimaActividad: ahora,
    },
    { upsert: true },
  );

  p.estado = 'aceptado';
  p.sesion = { accessToken: sesion.accessToken, refreshToken: sesion.refreshToken, nombre: sesion.nombre };
  p.expiraEn = Date.now() + RESPUESTA_TTL_MS;
  return { estado: p.estado };
}

/** Mismos tokens que da /auth/login-app, con su registro en el panel de sesiones. */
async function abrirSesionEscolares(escolaresUserId: string, req: Request) {
  const user = await database.getCollection<User>('users').findOne({ id: escolaresUserId });
  if (!user || user.activo === false) throw new ErrorAutorizaciones(404, 'La cuenta de escolares ya no existe');
  const sessionId = jwtConfig.generateSessionId();
  const nombre = user.nombreCompleto || user.username;
  const tokens = jwtConfig.generateTokens({
    userId: user.id,
    email: user.email,
    rol: user.rol || 'usuario',
    username: user.username,
    nombre,
    deliveryPersonId: user.deliveryPersonId,
    sessionId,
  });
  await createSessionRecord(user.id, user.username, user.email, user.rol || 'usuario', sessionId, req);
  return { ...tokens, sessionId, nombre };
}

// ---------------------------------------------------------------- celular nuevo (sin sesión)

export async function escanearQr(datos: { qr?: unknown; dispositivoId?: unknown; dispositivoNombre?: unknown }) {
  const texto = typeof datos.qr === 'string' ? datos.qr : '';
  const dispositivoId = typeof datos.dispositivoId === 'string' ? datos.dispositivoId.trim() : '';
  const nombre = (typeof datos.dispositivoNombre === 'string' ? datos.dispositivoNombre.trim().slice(0, 80) : '') || 'Celular';
  if (!texto || !dispositivoId || dispositivoId.length > 100) throw new ErrorAutorizaciones(400, 'Datos incompletos');

  const p = buscarPorQrOCodigo(texto);
  if (!p || p.estado !== 'esperando') throw new ErrorAutorizaciones(404, 'QR o código inválido o vencido. Pide uno nuevo en el celular principal.');

  if (dispositivoId === p.principalDispositivoId) throw new ErrorAutorizaciones(409, 'Este es el celular principal: escanea el QR desde otro celular');
  if (await vinculoPorDispositivo(dispositivoId)) {
    throw new ErrorAutorizaciones(409, 'Este celular es el principal de otra cuenta. Primero deben desvincularlo en EscolaresPRO.');
  }
  const secundario = await secundarioPorDispositivo(dispositivoId);
  if (secundario && secundario.sellhubUsuarioId !== p.sellhubUsuarioId) {
    throw new ErrorAutorizaciones(409, 'Este celular ya está vinculado a otra cuenta. Ciérrale la sesión primero.');
  }

  const espera = crypto.randomBytes(24).toString('base64url');
  p.estado = 'escaneado';
  p.candidato = { dispositivoId, nombre, espera };
  p.expiraEn = Date.now() + RESPUESTA_TTL_MS;
  emitirADispositivo(p.escolaresUserId, p.principalDispositivoId, 'dispositivo:escaneado', { token: p.token, candidatoNombre: nombre });
  return { espera, expiraEn: new Date(p.expiraEn) };
}

/** El celular nuevo pregunta si ya lo aceptaron; la sesión se entrega una sola vez. */
export function consultarEspera(espera: string, dispositivoId: string) {
  purgar();
  const p = [...porToken.values()].find((x) => x.candidato?.espera === espera);
  if (!p || p.candidato!.dispositivoId !== dispositivoId) return { estado: 'vencido' as const };
  if (p.estado === 'aceptado' && p.sesion) {
    porToken.delete(p.token);
    return { estado: 'aceptado' as const, ...p.sesion };
  }
  return { estado: p.estado === 'rechazado' ? ('rechazado' as const) : ('esperando' as const) };
}

// ---------------------------------------------------------------- lista y retiro

export async function listarDispositivos(vinculo: VinculoAutorizaciones, dispositivoId: string) {
  const secundarios = await (await coleccionSecundarios())
    .find({ sellhubUsuarioId: vinculo._id })
    .sort({ vinculadoEn: 1 })
    .toArray();
  return {
    max: MAX_SECUNDARIOS,
    principal: {
      nombre: vinculo.dispositivoNombre,
      vinculadoEn: vinculo.vinculadoEn,
      esEste: vinculo.dispositivoId === dispositivoId,
    },
    secundarios: secundarios.map((d) => ({
      id: d.id,
      nombre: d.dispositivoNombre,
      vinculadoEn: d.vinculadoEn,
      ultimaActividad: d.ultimaActividad,
      esEste: d._id === dispositivoId,
    })),
  };
}

/** El principal retira cualquiera; un secundario solo a sí mismo (al cerrar sesión). */
export async function retirarDispositivo(vinculo: VinculoAutorizaciones, dispositivoIdActual: string, id: string): Promise<void> {
  const col = await coleccionSecundarios();
  const objetivo = await col.findOne({ id, sellhubUsuarioId: vinculo._id });
  if (!objetivo) throw new ErrorAutorizaciones(404, 'Ese dispositivo ya no está vinculado');
  if (vinculo.dispositivoId !== dispositivoIdActual && objetivo._id !== dispositivoIdActual) {
    throw new ErrorAutorizaciones(403, 'Solo el celular principal puede retirar otros dispositivos');
  }
  await col.deleteOne({ _id: objetivo._id });
  await cerrarSesionesEscolares([objetivo.sessionId], 'dispositivo_retirado');
  sacarDispositivoDeSalaUsuario(objetivo.escolaresUserId, objetivo._id, objetivo.sellhubUsuarioId);
  emitirADispositivo(objetivo.escolaresUserId, objetivo._id, 'dispositivo:retirado', {});
}

// ---------------------------------------------------------------- actividad

const ultimoToque = new Map<string, number>();

/** "Última actividad" de la lista; como mucho una escritura por minuto por celular. */
export function tocarSecundario(secundario: DispositivoSecundario): void {
  const ahora = Date.now();
  if ((ultimoToque.get(secundario._id) ?? 0) > ahora - 60_000) return;
  ultimoToque.set(secundario._id, ahora);
  void coleccionSecundarios()
    .then((col) => col.updateOne({ _id: secundario._id }, { $set: { ultimaActividad: new Date(ahora) } }))
    .catch((error) => console.error('Autorizaciones: error guardando actividad del dispositivo:', error));
}
