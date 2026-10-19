import crypto from 'crypto';
import { emitirAUsuarios } from './autorizaciones-socket.service';
import { ErrorAutorizaciones, enviarPushAUsuarios, filtrarVinculados } from './autorizaciones-vinculos.service';
import {
  DetalleAccion,
  Evento,
  RegistroHistorial,
  TIPOS_EVENTO,
  TipoEvento,
  guardarEvento,
  guardarHistorial,
  limpiarDetalles,
  listaIds,
  texto,
  vistaEvento,
  vistaHistorial,
} from './autorizaciones-historial.service';

/**
 * Ciclo de vida de una solicitud de autorización:
 *
 *   pendiente ──(celular manda PIN)──▶ respondida ──(caja lo recoge)──▶ verificando
 *       ▲                                                                   │
 *       └────────────── PIN inválido (menos de MAX_INTENTOS) ◀──────────────┤
 *                                                                           ▼
 *                                                          aprobada / bloqueada
 *
 * Además: rechazada (desde el celular), cancelada (la caja cerró el modal), expirada
 * (nadie respondió a tiempo) y aprobada con origen 'caja' (se autorizó con el PIN en la
 * caja mientras esperaba al celular). Al resolverse pasa al historial permanente
 * (autorizaciones-historial.service.ts); aquí solo vive mientras está en curso.
 *
 * Quién la recibe lo decide sellhub: manda en `destinatarios` los usuarios cuyo rol tiene
 * el permiso móvil de esa acción, y aquí solo llega a los que tienen celular vinculado.
 *
 * Este backend nunca ve el PIN: el celular lo cifra con la llave pública RSA que generó la
 * caja para esta solicitud, y solo la caja tiene la privada. La caja comprueba que el PIN
 * sea del usuario que respondió (`respondidoPor`).
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
  /** Clave de la acción en sellhub (descuento, gaveta...), para filtrar el historial. */
  accion: string;
  titulo: string;
  subtitulo: string | null;
  motivo: string | null;
  cajero: string;
  equipo: string;
  detalles: DetalleAccion[];
  /** Llave pública RSA-OAEP (SPKI, base64) para cifrar el PIN. */
  clavePublica: string;
  /** Usuarios de sellhub con permiso (vinculados o no): quienes la verán en el historial. */
  permitidos: string[];
  /** De los permitidos, los que tienen celular vinculado: quienes pueden responder ahora. */
  destinatarios: string[];
  origen: 'celular' | 'caja';
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

export const MAX_INTENTOS = 3;
const SOLICITUD_TTL_MS = 2 * 60_000;
/** Tras resolverse, la tarjeta se sigue viendo un momento con su estado final; luego queda solo en el historial. */
const RETENER_MS = 2 * 60_000;
const ESTADOS_ABIERTOS: EstadoSolicitud[] = ['pendiente', 'respondida', 'verificando'];

const solicitudes = new Map<string, Solicitud>();

const abierta = (s: Solicitud) => ESTADOS_ABIERTOS.includes(s.estado);

function obtener(id: string): Solicitud {
  const s = solicitudes.get(id);
  if (!s) throw new ErrorAutorizaciones(404, 'La solicitud no existe o ya expiró');
  return s;
}

/** Lo que ve el celular: sin PIN cifrado ni listas de usuarios. */
export function vistaMovil(s: Solicitud) {
  const { pinCifrado: _pin, destinatarios: _dest, permitidos: _perm, respondidoPor: _por, ...resto } = s;
  return { ...resto, intentosRestantes: MAX_INTENTOS - s.intentosFallidos };
}

/** Lo que ve la caja: sin la llave pública (ya la tiene). */
function vistaCaja(s: Solicitud) {
  const { clavePublica: _clave, permitidos: _perm, ...resto } = s;
  return { ...resto, intentosRestantes: MAX_INTENTOS - s.intentosFallidos };
}

function notificarCambio(s: Solicitud): void {
  emitirAUsuarios(s.destinatarios, 'solicitud', vistaMovil(s));
}

function aHistorial(s: Solicitud): RegistroHistorial {
  return {
    _id: s.id,
    accion: s.accion,
    titulo: s.titulo,
    subtitulo: s.subtitulo,
    motivo: s.motivo,
    cajero: s.cajero,
    equipo: s.equipo,
    detalles: s.detalles,
    origen: s.origen,
    estado: s.estado,
    supervisor: s.supervisor,
    respondidoPorNombre: s.respondidoPorNombre,
    mensaje: s.mensaje,
    intentosFallidos: s.intentosFallidos,
    creadaEn: s.creadaEn,
    resueltaEn: s.resueltaEn ?? new Date(),
    destinatarios: s.permitidos,
  };
}

async function archivar(registro: RegistroHistorial): Promise<void> {
  try {
    await guardarHistorial(registro);
    const vinculados = await filtrarVinculados(registro.destinatarios);
    emitirAUsuarios(vinculados, 'historial', vistaHistorial(registro));
  } catch (error) {
    console.error('Autorizaciones: no se pudo guardar en el historial:', error);
  }
}

function resolver(s: Solicitud, estado: EstadoSolicitud, mensaje: string | null = null): void {
  s.estado = estado;
  s.mensaje = mensaje;
  s.pinCifrado = null;
  s.resueltaEn = new Date();
  notificarCambio(s);
  void archivar(aHistorial(s));
}

/** Datos comunes que manda sellhub al crear una solicitud o registrar una autorización. */
function datosAccion(input: Record<string, unknown>) {
  const titulo = texto(input.titulo, 120);
  if (!titulo) throw new ErrorAutorizaciones(400, 'Falta el título');
  return {
    accion: texto(input.accion, 40) ?? 'otra',
    titulo,
    subtitulo: texto(input.subtitulo, 200),
    motivo: texto(input.motivo, 200),
    cajero: texto(input.cajero, 150) ?? 'Cajero',
    equipo: texto(input.equipo, 150) ?? '',
    detalles: limpiarDetalles(input.detalles),
    permitidos: listaIds(input.destinatarios),
  };
}

// ---------------------------------------------------------------- caja (sellhub)

export async function crearSolicitud(input: Record<string, unknown>) {
  const datos = datosAccion(input);
  const clavePublica = texto(input.clavePublica, 2000);
  if (!clavePublica) throw new ErrorAutorizaciones(400, 'Falta la llave pública');

  const destinatarios = await filtrarVinculados(datos.permitidos);
  if (destinatarios.length === 0) {
    throw new ErrorAutorizaciones(409, 'Ningún supervisor con permiso para esta acción tiene el celular vinculado');
  }

  const ahora = new Date();
  const s: Solicitud = {
    id: crypto.randomUUID(),
    ...datos,
    clavePublica,
    destinatarios,
    origen: 'celular',
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

  const monto = s.detalles.find((d) => d.destacado)?.valor;
  const detalle = [monto, s.cajero, s.equipo, s.motivo].filter(Boolean).join(' · ');
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

/**
 * Autorización hecha con el PIN en la propia caja. Si había una solicitud abierta en los
 * celulares para lo mismo, se cierra como aprobada en caja (un solo registro); si no,
 * se crea el registro directamente en el historial.
 */
export async function registrarAutorizacionEnCaja(input: Record<string, unknown>): Promise<void> {
  const supervisor = texto(input.supervisor, 150);
  const abiertaId = texto(input.solicitudId, 60);
  const s = abiertaId ? solicitudes.get(abiertaId) : undefined;
  if (s && abierta(s)) {
    s.origen = 'caja';
    s.supervisor = supervisor;
    resolver(s, 'aprobada', 'Autorizada con el PIN en la caja');
    return;
  }

  const datos = datosAccion(input);
  const ahora = new Date();
  await archivar({
    _id: crypto.randomUUID(),
    accion: datos.accion,
    titulo: datos.titulo,
    subtitulo: datos.subtitulo,
    motivo: datos.motivo,
    cajero: datos.cajero,
    equipo: datos.equipo,
    detalles: datos.detalles,
    origen: 'caja',
    estado: 'aprobada',
    supervisor,
    respondidoPorNombre: null,
    mensaje: null,
    intentosFallidos: 0,
    creadaEn: ahora,
    resueltaEn: ahora,
    destinatarios: datos.permitidos,
  });
}

/** Push solo para lo que pide atención; los inicios/cierres de sesión van a un canal discreto. */
const PUSH_EVENTO: Record<TipoEvento, 'autorizaciones' | 'eventos'> = {
  asistencia: 'autorizaciones',
  sesion_fallida: 'eventos',
  sesion_inicio: 'eventos',
  sesion_cierre: 'eventos',
};

export async function crearEvento(input: Record<string, unknown>): Promise<{ id: string; enviados: number }> {
  const tipo = TIPOS_EVENTO.find((t) => t === input.tipo);
  const titulo = texto(input.titulo, 150);
  if (!tipo || !titulo) throw new ErrorAutorizaciones(400, 'Faltan el tipo o el título del evento');

  const evento: Evento = {
    _id: crypto.randomUUID(),
    tipo,
    titulo,
    cuerpo: texto(input.cuerpo, 400) ?? '',
    usuario: texto(input.usuario, 150),
    equipo: texto(input.equipo, 150),
    detalles: limpiarDetalles(input.detalles),
    creadoEn: new Date(),
    destinatarios: listaIds(input.destinatarios),
  };
  if (evento.destinatarios.length === 0) return { id: evento._id, enviados: 0 };

  await guardarEvento(evento);
  const vinculados = await filtrarVinculados(evento.destinatarios);
  emitirAUsuarios(vinculados, 'evento', vistaEvento(evento));
  enviarPushAUsuarios(
    vinculados,
    { title: evento.titulo, body: evento.cuerpo, data: { tipo: 'evento', eventoId: evento._id } },
    PUSH_EVENTO[tipo],
  ).catch((err) => console.error('Error enviando push:', err));
  return { id: evento._id, enviados: vinculados.length };
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
  }, 5000);
}
