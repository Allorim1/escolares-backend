import crypto from 'crypto';
import { emitirAUsuarios } from './autorizaciones-socket.service';
import { ErrorAutorizaciones, enviarPushAUsuarios, filtrarVinculados } from './autorizaciones-vinculos.service';

/**
 * Ciclo de vida de una solicitud de autorización:
 *
 *   pendiente ──(celular manda PIN)──▶ respondida ──(caja lo recoge)──▶ verificando
 *       ▲                                                                   │
 *       └────────────── PIN inválido (menos de MAX_INTENTOS) ◀──────────────┤
 *                                                                           ▼
 *                                                          aprobada / bloqueada
 *
 * Además: rechazada (desde el celular), cancelada (la caja cerró el modal) y
 * expirada (nadie respondió a tiempo).
 *
 * Quién la recibe lo decide sellhub: manda en `destinatarios` los usuarios
 * cuyo rol tiene el permiso móvil de esa acción, y aquí solo llega a los que
 * tienen celular vinculado. Solo un destinatario puede responderla.
 *
 * Este backend nunca ve el PIN: el celular lo cifra con la llave pública RSA que
 * generó la caja para esta solicitud, y solo la caja tiene la privada. La caja
 * comprueba que el PIN sea del usuario que respondió (`respondidoPor`).
 */
export type EstadoSolicitud =
  | 'pendiente'
  | 'respondida'
  | 'verificando'
  | 'aprobada'
  | 'rechazada'
  | 'bloqueada'
  | 'cancelada'
  | 'expirada';

export interface Solicitud {
  id: string;
  titulo: string;
  subtitulo: string | null;
  motivo: string | null;
  cajero: string;
  equipo: string;
  /** Llave pública RSA-OAEP (SPKI, base64) para cifrar el PIN. */
  clavePublica: string;
  /** Usuarios de sellhub (con celular vinculado) que pueden responder. */
  destinatarios: string[];
  creadaEn: Date;
  expiraEn: Date;
  estado: EstadoSolicitud;
  intentosFallidos: number;
  pinCifrado: string | null;
  /** Usuario de sellhub que respondió por última vez (aprobó o rechazó). */
  respondidoPor: string | null;
  respondidoPorNombre: string | null;
  supervisor: string | null;
  mensaje: string | null;
  resueltaEn: Date | null;
}

/** Aviso informativo (sin respuesta), p. ej. "Solicitar supervisor" desde una caja. */
export interface Aviso {
  id: string;
  titulo: string;
  cuerpo: string;
  destinatarios: string[];
  creadoEn: Date;
}

export const MAX_INTENTOS = 3;
const SOLICITUD_TTL_MS = 2 * 60_000;
/** Las solicitudes resueltas y los avisos se siguen mostrando un rato en el celular como historial reciente. */
const RETENER_MS = 10 * 60_000;
const ESTADOS_ABIERTOS: EstadoSolicitud[] = ['pendiente', 'respondida', 'verificando'];

const solicitudes = new Map<string, Solicitud>();
const avisos = new Map<string, Aviso>();

const abierta = (s: Solicitud) => ESTADOS_ABIERTOS.includes(s.estado);

function obtener(id: string): Solicitud {
  const s = solicitudes.get(id);
  if (!s) throw new ErrorAutorizaciones(404, 'La solicitud no existe o ya expiró');
  return s;
}

/** Lo que ve el celular: sin PIN cifrado ni la lista de destinatarios. */
export function vistaMovil(s: Solicitud) {
  const { pinCifrado: _pin, destinatarios: _dest, respondidoPor: _por, ...resto } = s;
  return { ...resto, intentosRestantes: MAX_INTENTOS - s.intentosFallidos };
}

/** Lo que ve la caja: sin la llave pública (ya la tiene). */
function vistaCaja(s: Solicitud) {
  const { clavePublica: _clave, ...resto } = s;
  return { ...resto, intentosRestantes: MAX_INTENTOS - s.intentosFallidos };
}

function notificarCambio(s: Solicitud): void {
  emitirAUsuarios(s.destinatarios, 'solicitud', vistaMovil(s));
}

function resolver(s: Solicitud, estado: EstadoSolicitud, mensaje: string | null = null): void {
  s.estado = estado;
  s.mensaje = mensaje;
  s.pinCifrado = null;
  s.resueltaEn = new Date();
  notificarCambio(s);
}

const texto = (valor: unknown, max: number): string | null =>
  typeof valor === 'string' && valor.trim() ? valor.trim().slice(0, max) : null;

const listaIds = (valor: unknown): string[] =>
  Array.isArray(valor) ? [...new Set(valor.map(String).filter(Boolean))].slice(0, 500) : [];

// ---------------------------------------------------------------- caja (sellhub)

export async function crearSolicitud(input: Record<string, unknown>) {
  const titulo = texto(input.titulo, 120);
  const clavePublica = texto(input.clavePublica, 2000);
  if (!titulo || !clavePublica) throw new ErrorAutorizaciones(400, 'Faltan el título o la llave pública');

  const destinatarios = await filtrarVinculados(listaIds(input.destinatarios));
  if (destinatarios.length === 0) {
    throw new ErrorAutorizaciones(409, 'Ningún supervisor con permiso para esta acción tiene el celular vinculado');
  }

  const ahora = new Date();
  const s: Solicitud = {
    id: crypto.randomUUID(),
    titulo,
    subtitulo: texto(input.subtitulo, 200),
    motivo: texto(input.motivo, 200),
    cajero: texto(input.cajero, 150) ?? 'Cajero',
    equipo: texto(input.equipo, 150) ?? '',
    clavePublica,
    destinatarios,
    creadaEn: ahora,
    expiraEn: new Date(ahora.getTime() + SOLICITUD_TTL_MS),
    estado: 'pendiente',
    intentosFallidos: 0,
    pinCifrado: null,
    respondidoPor: null,
    respondidoPorNombre: null,
    supervisor: null,
    mensaje: null,
    resueltaEn: null,
  };
  solicitudes.set(s.id, s);
  notificarCambio(s);

  const detalle = [s.cajero, s.equipo, s.motivo].filter(Boolean).join(' · ');
  enviarPushAUsuarios(destinatarios, {
    title: `🔐 ${s.titulo}`,
    body: detalle || 'Requiere autorización de un supervisor',
    data: { tipo: 'solicitud', solicitudId: s.id },
  }).catch((err) => console.error('Error enviando push:', err));

  return vistaCaja(s);
}

/**
 * Estado actual para la caja. Si el celular ya mandó el PIN, se entrega una
 * sola vez (y pasa a "verificando"): la caja debe responder con registrarResultado.
 */
export function consultarDesdeCaja(id: string) {
  const s = obtener(id);
  const vista = vistaCaja(s);
  if (s.estado === 'respondida' && s.pinCifrado) {
    s.pinCifrado = null;
    s.estado = 'verificando';
    notificarCambio(s);
  }
  return vista;
}

export function registrarResultado(id: string, ok: boolean, supervisor: string | null, mensaje: string | null) {
  const s = obtener(id);
  if (s.estado !== 'verificando') throw new ErrorAutorizaciones(409, 'La solicitud no está esperando verificación');

  if (ok) {
    s.supervisor = texto(supervisor, 150);
    resolver(s, 'aprobada');
  } else {
    s.intentosFallidos += 1;
    if (s.intentosFallidos >= MAX_INTENTOS) {
      resolver(s, 'bloqueada', 'Demasiados PIN inválidos');
    } else {
      s.estado = 'pendiente';
      s.mensaje = texto(mensaje, 200) ?? 'PIN de supervisor inválido';
      notificarCambio(s);
    }
  }
  return vistaCaja(s);
}

export function cancelarDesdeCaja(id: string): void {
  const s = solicitudes.get(id);
  if (s && abierta(s)) resolver(s, 'cancelada', 'La caja canceló la solicitud');
}

export async function crearAviso(input: Record<string, unknown>): Promise<{ id: string; enviados: number }> {
  const titulo = texto(input.titulo, 120);
  const cuerpo = texto(input.cuerpo, 300) ?? '';
  if (!titulo) throw new ErrorAutorizaciones(400, 'Falta el título');

  const destinatarios = await filtrarVinculados(listaIds(input.destinatarios));
  const aviso: Aviso = { id: crypto.randomUUID(), titulo, cuerpo, destinatarios, creadoEn: new Date() };
  if (destinatarios.length === 0) return { id: aviso.id, enviados: 0 };

  avisos.set(aviso.id, aviso);
  const { destinatarios: _dest, ...vista } = aviso;
  emitirAUsuarios(destinatarios, 'aviso', vista);
  enviarPushAUsuarios(destinatarios, { title: titulo, body: cuerpo, data: { tipo: 'aviso', avisoId: aviso.id } }).catch((err) =>
    console.error('Error enviando push:', err),
  );
  return { id: aviso.id, enviados: destinatarios.length };
}

// ---------------------------------------------------------------- celular

function verificarDestinatario(s: Solicitud, sellhubUsuarioId: string): void {
  if (!s.destinatarios.includes(sellhubUsuarioId)) {
    throw new ErrorAutorizaciones(403, 'No tienes permiso para responder esta solicitud');
  }
}

export function listarParaMovil(sellhubUsuarioId: string) {
  return [...solicitudes.values()]
    .filter((s) => s.destinatarios.includes(sellhubUsuarioId))
    .sort((a, b) => b.creadaEn.getTime() - a.creadaEn.getTime())
    .map(vistaMovil);
}

export function listarAvisosParaMovil(sellhubUsuarioId: string) {
  return [...avisos.values()]
    .filter((a) => a.destinatarios.includes(sellhubUsuarioId))
    .sort((a, b) => b.creadoEn.getTime() - a.creadoEn.getTime())
    .map(({ destinatarios: _dest, ...vista }) => vista);
}

export function aprobarDesdeMovil(id: string, pinCifrado: unknown, sellhubUsuarioId: string, nombre: string) {
  const s = obtener(id);
  verificarDestinatario(s, sellhubUsuarioId);
  if (s.estado !== 'pendiente') {
    throw new ErrorAutorizaciones(409, s.estado === 'respondida' || s.estado === 'verificando'
      ? 'Otro supervisor ya está respondiendo esta solicitud'
      : 'La solicitud ya no está pendiente');
  }
  const cifrado = texto(pinCifrado, 2000);
  if (!cifrado) throw new ErrorAutorizaciones(400, 'Falta el PIN');

  s.pinCifrado = cifrado;
  s.estado = 'respondida';
  s.respondidoPor = sellhubUsuarioId;
  s.respondidoPorNombre = nombre;
  s.mensaje = null;
  notificarCambio(s);
  return vistaMovil(s);
}

export function rechazarDesdeMovil(id: string, sellhubUsuarioId: string, nombre: string) {
  const s = obtener(id);
  verificarDestinatario(s, sellhubUsuarioId);
  if (s.estado !== 'pendiente') throw new ErrorAutorizaciones(409, 'La solicitud ya no está pendiente');
  s.respondidoPor = sellhubUsuarioId;
  s.respondidoPorNombre = nombre;
  resolver(s, 'rechazada', `Rechazada por ${nombre}`);
  return vistaMovil(s);
}

// ---------------------------------------------------------------- limpieza

export function iniciarLimpieza(): void {
  setInterval(() => {
    const ahora = Date.now();
    for (const s of solicitudes.values()) {
      if (abierta(s) && s.expiraEn.getTime() <= ahora) {
        resolver(s, 'expirada', 'Nadie respondió a tiempo');
      } else if (s.resueltaEn && ahora - s.resueltaEn.getTime() > RETENER_MS) {
        solicitudes.delete(s.id);
        emitirAUsuarios(s.destinatarios, 'solicitud:eliminada', { id: s.id });
      }
    }
    for (const a of avisos.values()) {
      if (ahora - a.creadoEn.getTime() > RETENER_MS) avisos.delete(a.id);
    }
  }, 5000);
}
