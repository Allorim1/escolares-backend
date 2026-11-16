import crypto from 'crypto';
import { emitirAUsuarios } from './autorizaciones-socket.service';
import { aIdsSellhub, ErrorAutorizaciones, enviarPushAUsuarios, filtrarVinculados } from './autorizaciones-vinculos.service';
import { idSellhub, nombreTienda, prefijoTienda, uid } from './autorizaciones-tiendas.service';
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
 * Multitienda: cada solicitud es de la tienda cuya clave la creó (`tiendaId`); solo esa
 * tienda la puede consultar o resolver. Los usuarios se guardan como ids internos
 * `tienda:usuario` y a la caja se le devuelven con su id simple.
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
  tiendaId: string;
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
  /** Solo la ven en el historial ya resuelta (marcaron "Historial de autorizaciones" en sellhub). */
  observadores: string[];
  origen: 'celular' | 'caja';
  creadaEn: Date;
  expiraEn: Date;
  estado: EstadoSolicitud;
  intentosFallidos: number;
  pinCifrado: string | null;
  /** Usuario (id interno) que respondió por última vez (aprobó o rechazó). */
  respondidoPor: string | null;
  respondidoPorNombre: string | null;
  supervisor: string | null;
  mensaje: string | null;
  resueltaEn: Date | null;
}

/** Vínculo con el que un celular responde: uno por tienda. */
export interface QuienResponde {
  _id: string;
  sellhubNombre: string;
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

/** Para la caja: solo las de su tienda (otra tienda no puede verlas ni resolverlas). */
function obtenerDeTienda(tiendaId: string, id: string): Solicitud {
  const s = obtener(id);
  if (s.tiendaId !== tiendaId) throw new ErrorAutorizaciones(404, 'La solicitud no existe o ya expiró');
  return s;
}

/** Lo que ve el celular: sin PIN cifrado ni listas de usuarios, con el nombre de la tienda. */
export function vistaMovil(s: Solicitud) {
  const { pinCifrado: _pin, destinatarios: _dest, permitidos: _perm, observadores: _obs, respondidoPor: _por, ...resto } = s;
  return { ...resto, tiendaNombre: nombreTienda(s.tiendaId), intentosRestantes: MAX_INTENTOS - s.intentosFallidos };
}

/** Lo que ve la caja: sin la llave pública (ya la tiene), con los ids de usuario de su sellhub. */
function vistaCaja(s: Solicitud) {
  const { clavePublica: _clave, permitidos: _perm, observadores: _obs, tiendaId: _tienda, ...resto } = s;
  return {
    ...resto,
    destinatarios: aIdsSellhub(s.destinatarios),
    respondidoPor: s.respondidoPor ? idSellhub(s.respondidoPor) : null,
    intentosRestantes: MAX_INTENTOS - s.intentosFallidos,
  };
}

function notificarCambio(s: Solicitud): void {
  emitirAUsuarios(s.destinatarios, 'solicitud', vistaMovil(s));
}

function aHistorial(s: Solicitud): RegistroHistorial {
  return {
    _id: s.id,
    tiendaId: s.tiendaId,
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
    destinatarios: [...new Set([...s.permitidos, ...s.observadores])],
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
  // Solo a las APKs nuevas: quitan (o actualizan) la notificación y refrescan el widget.
  enviarPushAUsuarios(s.destinatarios, { title: '', body: '' }, 'autorizaciones', {
    data: { tipo: 'solicitud_cerrada', solicitudId: s.id, estado, mensaje: mensaje ?? '', respondidoPor: s.respondidoPorNombre ?? '' },
    soloNativos: true,
  }).catch((err) => console.error('Error enviando push:', err));
}

/**
 * Acciones de uso temporal (el supervisor elige por cuántos minutos): desde la notificación
 * no se pueden elegir, así que "Aprobar" abre la app. Espejo de ACCIONES_TEMPORALES en
 * ion/escolares-pro/src/app/util.ts.
 */
const ACCIONES_TEMPORALES = new Set(['relacion_cuentas', 'relacion_cuentas_ver', 'inventario_productos', 'inventario_precios', 'inventario_catalogos']);

/** Ids de usuario de un sellhub → ids internos de su tienda. */
const deTienda = (tiendaId: string, ids: string[]) => ids.map((id) => uid(tiendaId, id));

/** Datos comunes que manda sellhub al crear una solicitud o registrar una autorización. */
function datosAccion(tiendaId: string, input: Record<string, unknown>) {
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
    permitidos: deTienda(tiendaId, listaIds(input.destinatarios)),
    observadores: deTienda(tiendaId, listaIds(input.observadores)),
  };
}

// ---------------------------------------------------------------- caja (sellhub)

export async function crearSolicitud(tiendaId: string, input: Record<string, unknown>) {
  const datos = datosAccion(tiendaId, input);
  const clavePublica = texto(input.clavePublica, 2000);
  if (!clavePublica) throw new ErrorAutorizaciones(400, 'Falta la llave pública');

  const destinatarios = await filtrarVinculados(datos.permitidos);
  if (destinatarios.length === 0) {
    throw new ErrorAutorizaciones(409, 'Ningún supervisor con permiso para esta acción tiene el celular vinculado');
  }

  const ahora = new Date();
  const s: Solicitud = {
    id: crypto.randomUUID(),
    tiendaId,
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
  const cuerpo = detalle || 'Requiere autorización de un supervisor';
  // Con varias tiendas, el aviso dice de cuál es ("Centro · Descuento").
  const titulo = `${prefijoTienda(tiendaId)}${s.titulo}`;
  enviarPushAUsuarios(
    destinatarios,
    { title: `🔐 ${titulo}`, body: cuerpo, data: { tipo: 'solicitud', solicitudId: s.id, tiendaId } },
    'autorizaciones',
    // La APK nueva arma la notificación con "Aprobar" (PIN ahí mismo) y "Rechazar": necesita la
    // llave pública para cifrar el PIN sin abrir la app.
    {
      data: {
        tipo: 'solicitud',
        solicitudId: s.id,
        tiendaId,
        titulo,
        cuerpo,
        clavePublica: s.clavePublica,
        temporal: ACCIONES_TEMPORALES.has(s.accion) ? '1' : '0',
        // La APK no ofrece "Aprobar con huella" en inicio_sesion (ahí se escribe un número, no el PIN).
        accion: s.accion,
        expiraEn: s.expiraEn.toISOString(),
      },
    },
  ).catch((err) => console.error('Error enviando push:', err));

  return vistaCaja(s);
}

/**
 * Estado actual para la caja. Si el celular ya mandó el PIN, se entrega una
 * sola vez (y pasa a "verificando"): la caja debe responder con registrarResultado.
 */
export function consultarDesdeCaja(tiendaId: string, id: string) {
  const s = obtenerDeTienda(tiendaId, id);
  const vista = vistaCaja(s);
  if (s.estado === 'respondida' && s.pinCifrado) {
    s.pinCifrado = null;
    s.estado = 'verificando';
    notificarCambio(s);
  }
  return vista;
}

export function registrarResultado(tiendaId: string, id: string, ok: boolean, supervisor: string | null, mensaje: string | null) {
  const s = obtenerDeTienda(tiendaId, id);
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
      // Quien escribió el PIN desde la notificación la ve otra vez con el error y "Aprobar".
      if (s.respondidoPor) {
        enviarPushAUsuarios([s.respondidoPor], { title: '', body: '' }, 'autorizaciones', {
          data: {
            tipo: 'solicitud_pin_incorrecto',
            solicitudId: s.id,
            tiendaId: s.tiendaId,
            mensaje: s.mensaje,
            intentosRestantes: String(MAX_INTENTOS - s.intentosFallidos),
          },
          soloNativos: true,
        }).catch((err) => console.error('Error enviando push:', err));
      }
    }
  }
  return vistaCaja(s);
}

export function cancelarDesdeCaja(tiendaId: string, id: string): void {
  const s = solicitudes.get(id);
  if (s && s.tiendaId === tiendaId && abierta(s)) resolver(s, 'cancelada', 'La caja canceló la solicitud');
}

/**
 * Autorización hecha con el PIN en la propia caja. Si había una solicitud abierta en los
 * celulares para lo mismo, se cierra como aprobada en caja (un solo registro); si no,
 * se crea el registro directamente en el historial.
 */
export async function registrarAutorizacionEnCaja(tiendaId: string, input: Record<string, unknown>): Promise<void> {
  const supervisor = texto(input.supervisor, 150);
  const abiertaId = texto(input.solicitudId, 60);
  const s = abiertaId ? solicitudes.get(abiertaId) : undefined;
  if (s && s.tiendaId === tiendaId && abierta(s)) {
    s.origen = 'caja';
    s.supervisor = supervisor;
    resolver(s, 'aprobada', 'Autorizada con el PIN en la caja');
    return;
  }

  const datos = datosAccion(tiendaId, input);
  const ahora = new Date();
  await archivar({
    _id: crypto.randomUUID(),
    tiendaId,
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
    destinatarios: [...new Set([...datos.permitidos, ...datos.observadores])],
  });
}

/** Push solo para lo que pide atención; sesiones y registro de actividad van a un canal discreto. */
const PUSH_EVENTO: Record<TipoEvento, 'autorizaciones' | 'eventos'> = {
  asistencia: 'autorizaciones',
  sesion_fallida: 'eventos',
  sesion_inicio: 'eventos',
  sesion_cierre: 'eventos',
  factura_emitida: 'eventos',
  facturacion: 'eventos',
  caja: 'eventos',
  inventario: 'eventos',
  cliente_guardado: 'eventos',
  clientes: 'eventos',
  seguridad: 'eventos',
  configuracion: 'eventos',
  alerta: 'autorizaciones',
  reporte: 'eventos',
};

/** `input.destinatarios`: ids de usuario del sellhub de esa tienda. */
export async function crearEvento(tiendaId: string, input: Record<string, unknown>): Promise<{ id: string; enviados: number }> {
  const tipo = TIPOS_EVENTO.find((t) => t === input.tipo);
  const titulo = texto(input.titulo, 150);
  if (!tipo || !titulo) throw new ErrorAutorizaciones(400, 'Faltan el tipo o el título del evento');

  const evento: Evento = {
    _id: crypto.randomUUID(),
    tiendaId,
    tipo,
    titulo,
    cuerpo: texto(input.cuerpo, 400) ?? '',
    usuario: texto(input.usuario, 150),
    equipo: texto(input.equipo, 150),
    detalles: limpiarDetalles(input.detalles),
    creadoEn: new Date(),
    destinatarios: deTienda(tiendaId, listaIds(input.destinatarios)),
  };
  if (evento.destinatarios.length === 0) return { id: evento._id, enviados: 0 };

  await guardarEvento(evento);
  const vinculados = await filtrarVinculados(evento.destinatarios);
  emitirAUsuarios(vinculados, 'evento', vistaEvento(evento));
  enviarPushAUsuarios(
    vinculados,
    {
      title: `${prefijoTienda(tiendaId)}${evento.titulo}`,
      body: evento.cuerpo,
      data: { tipo: 'evento', eventoId: evento._id, eventoTipo: evento.tipo, tiendaId },
    },
    PUSH_EVENTO[tipo],
  ).catch((err) => console.error('Error enviando push:', err));
  return { id: evento._id, enviados: vinculados.length };
}

// ---------------------------------------------------------------- celular

/** Con cuál de sus vínculos (uno por tienda) responde el celular a esta solicitud. */
function quienResponde(s: Solicitud, vinculos: QuienResponde[]): QuienResponde {
  const v = vinculos.find((x) => s.destinatarios.includes(x._id));
  if (!v) throw new ErrorAutorizaciones(403, 'No tienes permiso para responder esta solicitud');
  return v;
}

const esDe = (s: Solicitud, usuarios: string[]) => s.destinatarios.some((d) => usuarios.includes(d));

/** `usuarios`: ids internos de los vínculos de la cuenta (todas sus tiendas). */
export function listarParaMovil(usuarios: string[]) {
  return [...solicitudes.values()]
    .filter((s) => esDe(s, usuarios))
    .sort((a, b) => b.creadaEn.getTime() - a.creadaEn.getTime())
    .map(vistaMovil);
}

/** Una solicitud (la notificación nativa pregunta así cómo terminó su PIN). */
export function solicitudParaMovil(id: string, usuarios: string[]) {
  const s = obtener(id);
  if (!esDe(s, usuarios)) throw new ErrorAutorizaciones(403, 'No tienes permiso para responder esta solicitud');
  return vistaMovil(s);
}

/** Lo que muestra el widget de la pantalla de inicio. */
export function pendientesParaWidget(usuarios: string[]) {
  const pendientes = [...solicitudes.values()]
    .filter((s) => s.estado === 'pendiente' && esDe(s, usuarios))
    .sort((a, b) => b.creadaEn.getTime() - a.creadaEn.getTime());
  const ultima = pendientes[0];
  return {
    pendientes: pendientes.length,
    ultima: ultima ? { titulo: `${prefijoTienda(ultima.tiendaId)}${ultima.titulo}`, cajero: ultima.cajero } : null,
  };
}

export function aprobarDesdeMovil(id: string, pinCifrado: unknown, vinculos: QuienResponde[]) {
  const s = obtener(id);
  const v = quienResponde(s, vinculos);
  if (s.estado !== 'pendiente') {
    throw new ErrorAutorizaciones(409, s.estado === 'respondida' || s.estado === 'verificando'
      ? 'Otro supervisor ya está respondiendo esta solicitud'
      : 'La solicitud ya no está pendiente');
  }
  const cifrado = texto(pinCifrado, 2000);
  if (!cifrado) throw new ErrorAutorizaciones(400, 'Falta el PIN');

  s.pinCifrado = cifrado;
  s.estado = 'respondida';
  s.respondidoPor = v._id;
  s.respondidoPorNombre = v.sellhubNombre;
  s.mensaje = null;
  notificarCambio(s);
  return vistaMovil(s);
}

export function rechazarDesdeMovil(id: string, vinculos: QuienResponde[]) {
  const s = obtener(id);
  const v = quienResponde(s, vinculos);
  if (s.estado !== 'pendiente') throw new ErrorAutorizaciones(409, 'La solicitud ya no está pendiente');
  s.respondidoPor = v._id;
  s.respondidoPorNombre = v.sellhubNombre;
  resolver(s, 'rechazada', `Rechazada por ${v.sellhubNombre}`);
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
