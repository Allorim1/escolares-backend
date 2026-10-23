import { Filter } from 'mongodb';
import { database } from '../config/database';

/**
 * Lo que queda guardado para la app de supervisores (ion/escolares-pro), a diferencia de
 * las solicitudes en curso (en memoria, ver autorizaciones-solicitudes.service.ts):
 *
 *  - historial: cada autorización con clave de supervisor ya resuelta, con todos los
 *    detalles que mandó sellhub (montos, productos, cliente...). Incluye las autorizadas
 *    con el PIN en la misma caja (origen 'caja'), no solo las respondidas desde el celular.
 *  - eventos: notificaciones de lo que pasa en el programa (inicios de sesión, intentos
 *    fallidos, "Solicitar supervisor"...).
 *
 * Quién ve cada registro lo decide sellhub al mandarlo: `destinatarios` son los usuarios
 * que en ese momento lo tenían marcado (Seguridad → Usuarios). Se guarda 1 año (índice TTL).
 */

/** Dato suelto de la acción tal como lo muestra sellhub ("Total" → "$ 120,50"). */
export interface DetalleAccion {
  etiqueta: string;
  valor: string;
  /** El dato principal (normalmente el monto): se muestra en la lista del historial. */
  destacado?: boolean;
}

export interface RegistroHistorial {
  _id: string;
  accion: string;
  titulo: string;
  subtitulo: string | null;
  motivo: string | null;
  cajero: string;
  equipo: string;
  detalles: DetalleAccion[];
  /** 'celular': respondida desde la app; 'caja': autorizada con el PIN en la propia caja. */
  origen: 'celular' | 'caja';
  estado: string;
  /** Quien autorizó (nombre que devolvió la validación del PIN en sellhub). */
  supervisor: string | null;
  /** Usuario de sellhub que respondió desde el celular (aprobó o rechazó). */
  respondidoPorNombre: string | null;
  mensaje: string | null;
  intentosFallidos: number;
  creadaEn: Date;
  resueltaEn: Date;
  destinatarios: string[];
}

/**
 * Además de sesiones y "Solicitar supervisor", el registro de actividad de sellhub manda
 * un tipo por categoría (ver src/services/registroActividad.ts de sellhub).
 */
export const TIPOS_EVENTO = [
  'sesion_inicio',
  'sesion_fallida',
  'sesion_cierre',
  'asistencia',
  'facturacion',
  'caja',
  'inventario',
  'clientes',
  'seguridad',
  'configuracion',
] as const;
export type TipoEvento = (typeof TIPOS_EVENTO)[number];

export interface Evento {
  _id: string;
  tipo: TipoEvento;
  titulo: string;
  cuerpo: string;
  /** Usuario de sellhub al que se refiere el evento (quien inició sesión, quien pidió ayuda...). */
  usuario: string | null;
  equipo: string | null;
  detalles: DetalleAccion[];
  creadoEn: Date;
  destinatarios: string[];
}

const UN_ANIO_S = 365 * 24 * 60 * 60;
const LIMITE_PAGINA = 30;

let indicesListos: Promise<void> | null = null;
function asegurarIndices(): Promise<void> {
  indicesListos ??= Promise.all([
    database.getCollection('autorizaciones_historial').createIndex({ destinatarios: 1, creadaEn: -1 }),
    database.getCollection('autorizaciones_historial').createIndex({ creadaEn: 1 }, { expireAfterSeconds: UN_ANIO_S }),
    database.getCollection('autorizaciones_eventos').createIndex({ destinatarios: 1, creadoEn: -1 }),
    database.getCollection('autorizaciones_eventos').createIndex({ creadoEn: 1 }, { expireAfterSeconds: UN_ANIO_S }),
  ]).then(() => undefined);
  return indicesListos;
}

async function historial() {
  await asegurarIndices();
  return database.getCollection<RegistroHistorial>('autorizaciones_historial');
}

async function eventos() {
  await asegurarIndices();
  return database.getCollection<Evento>('autorizaciones_eventos');
}

// ---------------------------------------------------------------- validación de entrada

export const texto = (valor: unknown, max: number): string | null =>
  typeof valor === 'string' && valor.trim() ? valor.trim().slice(0, max) : null;

export const listaIds = (valor: unknown): string[] =>
  Array.isArray(valor) ? [...new Set(valor.map(String).filter(Boolean))].slice(0, 500) : [];

export function limpiarDetalles(valor: unknown): DetalleAccion[] {
  if (!Array.isArray(valor)) return [];
  return valor
    .slice(0, 40)
    .map((d) => ({
      etiqueta: texto(d?.etiqueta, 60) ?? '',
      valor: texto(d?.valor, 400) ?? '',
      ...(d?.destacado === true ? { destacado: true } : {}),
    }))
    .filter((d) => d.etiqueta && d.valor);
}

// ---------------------------------------------------------------- filtros de las listas

export interface FiltrosLista {
  desde?: Date;
  hasta?: Date;
  /** Paginación: registros anteriores a esta fecha. */
  antes?: Date;
  q?: string;
  limite: number;
}

const fecha = (valor: unknown): Date | undefined => {
  if (typeof valor !== 'string' || !valor) return undefined;
  const f = new Date(valor);
  return Number.isNaN(f.getTime()) ? undefined : f;
};

const lista = (valor: unknown): string[] =>
  typeof valor === 'string' && valor ? valor.split(',').map((v) => v.trim()).filter(Boolean).slice(0, 20) : [];

const escaparRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function leerFiltros(query: Record<string, unknown>): FiltrosLista {
  const limite = Math.min(Math.max(Number(query.limite) || LIMITE_PAGINA, 1), 100);
  return {
    desde: fecha(query.desde),
    hasta: fecha(query.hasta),
    antes: fecha(query.antes),
    q: texto(query.q, 80) ?? undefined,
    limite,
  };
}

function rangoFechas(f: FiltrosLista): Record<string, Date> | undefined {
  const rango: Record<string, Date> = {};
  if (f.desde) rango.$gte = f.desde;
  if (f.hasta) rango.$lte = f.hasta;
  if (f.antes && (!f.hasta || f.antes < f.hasta)) rango.$lt = f.antes;
  return Object.keys(rango).length ? rango : undefined;
}

const busqueda = (q: string | undefined, campos: string[]) =>
  q ? { $or: campos.map((c) => ({ [c]: { $regex: escaparRegex(q), $options: 'i' } })) } : {};

// ---------------------------------------------------------------- historial

export async function guardarHistorial(registro: RegistroHistorial): Promise<void> {
  await (await historial()).updateOne({ _id: registro._id }, { $set: registro }, { upsert: true });
}

/** Lo que ve el celular: sin la lista de destinatarios. */
export function vistaHistorial(r: RegistroHistorial) {
  const { destinatarios: _dest, ...vista } = r;
  return vista;
}

export async function listarHistorial(sellhubUsuarioId: string, query: Record<string, unknown>) {
  const f = leerFiltros(query);
  const estados = lista(query.estado);
  const acciones = lista(query.accion);
  const origen = query.origen === 'caja' || query.origen === 'celular' ? query.origen : undefined;
  const rango = rangoFechas(f);

  const filtro: Filter<RegistroHistorial> = {
    destinatarios: sellhubUsuarioId,
    ...(rango ? { creadaEn: rango } : {}),
    ...(estados.length ? { estado: { $in: estados } } : {}),
    ...(acciones.length ? { accion: { $in: acciones } } : {}),
    ...(origen ? { origen } : {}),
    ...busqueda(f.q, ['titulo', 'cajero', 'equipo', 'supervisor', 'respondidoPorNombre', 'motivo', 'detalles.valor']),
  };
  const filas = await (await historial()).find(filtro).sort({ creadaEn: -1 }).limit(f.limite + 1).toArray();
  return { registros: filas.slice(0, f.limite).map(vistaHistorial), hayMas: filas.length > f.limite };
}

export async function obtenerHistorial(sellhubUsuarioId: string, id: string) {
  const r = await (await historial()).findOne({ _id: id, destinatarios: sellhubUsuarioId });
  return r ? vistaHistorial(r) : null;
}

// ---------------------------------------------------------------- eventos

export async function guardarEvento(evento: Evento): Promise<void> {
  await (await eventos()).insertOne(evento);
}

export function vistaEvento(e: Evento) {
  const { destinatarios: _dest, ...vista } = e;
  return vista;
}

export async function listarEventos(sellhubUsuarioId: string, query: Record<string, unknown>) {
  const f = leerFiltros(query);
  const tipos = lista(query.tipo).filter((t): t is TipoEvento => (TIPOS_EVENTO as readonly string[]).includes(t));
  const rango = rangoFechas(f);

  const filtro: Filter<Evento> = {
    destinatarios: sellhubUsuarioId,
    ...(rango ? { creadoEn: rango } : {}),
    ...(tipos.length ? { tipo: { $in: tipos } } : {}),
    ...busqueda(f.q, ['titulo', 'cuerpo', 'usuario', 'equipo', 'detalles.valor']),
  };
  const filas = await (await eventos()).find(filtro).sort({ creadoEn: -1 }).limit(f.limite + 1).toArray();
  return { eventos: filas.slice(0, f.limite).map(vistaEvento), hayMas: filas.length > f.limite };
}
