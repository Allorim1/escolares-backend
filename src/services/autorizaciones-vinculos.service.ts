import crypto from 'crypto';
import { MongoServerError } from 'mongodb';
import { database } from '../config/database';
import { enviarDatosATokens, enviarPushATokens } from './push.service';
import { emitirAEscolares, sacarDeSalaUsuario } from './autorizaciones-socket.service';

/**
 * Vínculo entre un usuario de sellhub (EscolaresPRO, la app de escritorio de las cajas) y
 * el celular de su dueño con la app de supervisores (ion/escolares-pro).
 *
 *   1. En la app, la persona inicia sesión con su cuenta de escolares (/api/auth/login-app)
 *      y pide un código de vinculación de 6 dígitos (dura CODIGO_TTL_MS).
 *   2. En sellhub (Seguridad → Celulares), alguien con el permiso `movil_vincular` elige el
 *      usuario de sellhub y escribe ese código.
 *
 * Reglas: un usuario de sellhub tiene como máximo un celular principal (_id), una cuenta de
 * escolares se vincula a un solo usuario de sellhub y un celular físico (dispositivoId,
 * generado por la app) a un solo vínculo. Para cambiar de celular principal hay que
 * desvincular desde sellhub.
 *
 * Además, el principal puede sumar hasta MAX_SECUNDARIOS celulares secundarios con un QR
 * (ver autorizaciones-dispositivos.service.ts): entran con la misma cuenta y pueden hacer
 * lo mismo que el principal. Viven en `autorizaciones_dispositivos` y se borran junto con
 * el vínculo.
 */
export interface VinculoAutorizaciones {
  /** Id del usuario en sellhub (main.usuarios.id en su Postgres). */
  _id: string;
  sellhubNombre: string;
  escolaresUserId: string;
  escolaresNombre: string;
  dispositivoId: string;
  dispositivoNombre: string;
  pushTokens: string[];
  /** Tokens de APKs que dibujan ellas mismas la notificación de solicitud (botones Aprobar/Rechazar). */
  pushNativos?: string[];
  vinculadoEn: Date;
}

/** Celular extra vinculado por QR desde el principal (_id = su dispositivoId). */
export interface DispositivoSecundario {
  _id: string;
  /** Id público para listarlo y retirarlo (el dispositivoId no sale del backend). */
  id: string;
  sellhubUsuarioId: string;
  escolaresUserId: string;
  dispositivoNombre: string;
  pushTokens: string[];
  pushNativos?: string[];
  /** Sesión de escolares que se le abrió al vincularlo (se cierra al retirarlo). */
  sessionId: string;
  vinculadoEn: Date;
  ultimaActividad: Date;
}

export const MAX_SECUNDARIOS = 4;

interface CodigoPendiente {
  escolaresUserId: string;
  escolaresNombre: string;
  dispositivoId: string;
  dispositivoNombre: string;
  expiraEn: Date;
}

export class ErrorAutorizaciones extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

const CODIGO_TTL_MS = 10 * 60_000;
const codigos = new Map<string, CodigoPendiente>();

let indicesListos: Promise<void> | null = null;
async function coleccion() {
  const col = database.getCollection<VinculoAutorizaciones>('autorizaciones_vinculos');
  indicesListos ??= Promise.all([
    col.createIndex({ escolaresUserId: 1 }, { unique: true }),
    col.createIndex({ dispositivoId: 1 }, { unique: true }),
  ]).then(() => undefined);
  await indicesListos;
  return col;
}

let indicesSecundariosListos: Promise<void> | null = null;
export async function coleccionSecundarios() {
  const col = database.getCollection<DispositivoSecundario>('autorizaciones_dispositivos');
  indicesSecundariosListos ??= Promise.all([
    col.createIndex({ id: 1 }, { unique: true }),
    col.createIndex({ sellhubUsuarioId: 1 }),
  ]).then(() => undefined);
  await indicesSecundariosListos;
  return col;
}

export async function secundarioPorDispositivo(dispositivoId: string): Promise<DispositivoSecundario | null> {
  return (await coleccionSecundarios()).findOne({ _id: dispositivoId });
}

export async function vinculoPorEscolares(escolaresUserId: string): Promise<VinculoAutorizaciones | null> {
  return (await coleccion()).findOne({ escolaresUserId });
}

export async function vinculoPorDispositivo(dispositivoId: string): Promise<VinculoAutorizaciones | null> {
  return (await coleccion()).findOne({ dispositivoId });
}

/** Lo que el celular sabe de su vínculo (sin tokens push). */
export function vistaVinculo(v: VinculoAutorizaciones) {
  return { sellhubNombre: v.sellhubNombre, dispositivoNombre: v.dispositivoNombre, vinculadoEn: v.vinculadoEn };
}

// ---------------------------------------------------------------- celular

export async function generarCodigo(datos: Omit<CodigoPendiente, 'expiraEn'>): Promise<{ codigo: string; expiraEn: Date }> {
  if (await vinculoPorEscolares(datos.escolaresUserId)) {
    throw new ErrorAutorizaciones(409, 'Tu cuenta ya está vinculada a un celular');
  }
  if ((await vinculoPorDispositivo(datos.dispositivoId)) || (await secundarioPorDispositivo(datos.dispositivoId))) {
    throw new ErrorAutorizaciones(409, 'Este celular ya está vinculado con otra cuenta');
  }

  // Un solo código vivo por cuenta: pedir otro invalida el anterior.
  for (const [codigo, pendiente] of codigos) {
    if (pendiente.escolaresUserId === datos.escolaresUserId || pendiente.expiraEn.getTime() < Date.now()) codigos.delete(codigo);
  }
  let codigo: string;
  do {
    codigo = crypto.randomInt(0, 1_000_000).toString().padStart(6, '0');
  } while (codigos.has(codigo));

  const expiraEn = new Date(Date.now() + CODIGO_TTL_MS);
  codigos.set(codigo, { ...datos, expiraEn });
  return { codigo, expiraEn };
}

/** Un solo token por celular, en la lista que corresponde a su versión de la APK. */
const camposToken = (pushToken: string, nativo: boolean) =>
  nativo ? { pushTokens: [], pushNativos: [pushToken] } : { pushTokens: [pushToken], pushNativos: [] };

export async function guardarPushToken(vinculo: VinculoAutorizaciones, pushToken: string, nativo = false): Promise<void> {
  await (await coleccion()).updateOne({ _id: vinculo._id }, { $set: camposToken(pushToken, nativo) });
}

export async function borrarPushTokens(vinculo: VinculoAutorizaciones): Promise<void> {
  await (await coleccion()).updateOne({ _id: vinculo._id }, { $set: { pushTokens: [], pushNativos: [] } });
}

export async function guardarPushTokenSecundario(secundario: DispositivoSecundario, pushToken: string, nativo = false): Promise<void> {
  await (await coleccionSecundarios()).updateOne({ _id: secundario._id }, { $set: camposToken(pushToken, nativo) });
}

export async function borrarPushTokensSecundario(secundario: DispositivoSecundario): Promise<void> {
  await (await coleccionSecundarios()).updateOne({ _id: secundario._id }, { $set: { pushTokens: [], pushNativos: [] } });
}

// ---------------------------------------------------------------- caja (sellhub)

function codigoVigente(codigo: string): CodigoPendiente {
  const pendiente = codigos.get(codigo.trim());
  if (!pendiente || pendiente.expiraEn.getTime() < Date.now()) {
    codigos.delete(codigo.trim());
    throw new ErrorAutorizaciones(404, 'Código inválido o vencido. Pide uno nuevo en la app.');
  }
  return pendiente;
}

/** Vista previa para que sellhub muestre de quién es el código antes de confirmar. */
export function consultarCodigo(codigo: string) {
  const { escolaresNombre, dispositivoNombre, expiraEn } = codigoVigente(codigo);
  return { escolaresNombre, dispositivoNombre, expiraEn };
}

export async function vincular(codigo: string, sellhubUsuarioId: string, sellhubNombre: string): Promise<VinculoAutorizaciones> {
  const pendiente = codigoVigente(codigo);
  const col = await coleccion();
  if (await col.findOne({ _id: sellhubUsuarioId })) {
    throw new ErrorAutorizaciones(409, `${sellhubNombre} ya tiene un celular vinculado. Desvincúlalo primero.`);
  }

  if (await secundarioPorDispositivo(pendiente.dispositivoId)) {
    throw new ErrorAutorizaciones(409, 'Ese celular ya está vinculado como dispositivo secundario de otra cuenta');
  }

  const vinculo: VinculoAutorizaciones = {
    _id: sellhubUsuarioId,
    sellhubNombre,
    escolaresUserId: pendiente.escolaresUserId,
    escolaresNombre: pendiente.escolaresNombre,
    dispositivoId: pendiente.dispositivoId,
    dispositivoNombre: pendiente.dispositivoNombre,
    pushTokens: [],
    vinculadoEn: new Date(),
  };
  try {
    await col.insertOne(vinculo);
  } catch (error) {
    // Los índices únicos cubren la carrera de dos vinculaciones simultáneas.
    if (error instanceof MongoServerError && error.code === 11000) {
      throw new ErrorAutorizaciones(409, 'Esa cuenta o ese celular ya están vinculados a otro usuario');
    }
    throw error;
  }
  codigos.delete(codigo.trim());
  emitirAEscolares(vinculo.escolaresUserId, 'vinculo', vistaVinculo(vinculo));
  return vinculo;
}

export async function listarVinculos(): Promise<Omit<VinculoAutorizaciones, 'pushTokens'>[]> {
  return (await coleccion()).find({}, { projection: { pushTokens: 0 } }).sort({ sellhubNombre: 1 }).toArray();
}

export async function desvincular(sellhubUsuarioId: string): Promise<void> {
  const vinculo = await (await coleccion()).findOneAndDelete({ _id: sellhubUsuarioId });
  if (!vinculo) return;
  // Sin principal, los secundarios no tienen de quién colgar: se van con él.
  const secundarios = await coleccionSecundarios();
  const sesiones = (await secundarios.find({ sellhubUsuarioId }, { projection: { sessionId: 1 } }).toArray()).map((d) => d.sessionId);
  await secundarios.deleteMany({ sellhubUsuarioId });
  await cerrarSesionesEscolares(sesiones, 'dispositivo_desvinculado');
  emitirAEscolares(vinculo.escolaresUserId, 'vinculo:eliminado', {});
  sacarDeSalaUsuario(sellhubUsuarioId);
}

/** Marca como cerradas las sesiones de escolares abiertas a los secundarios (panel de sesiones). */
export async function cerrarSesionesEscolares(sessionIds: string[], motivo: string): Promise<void> {
  if (sessionIds.length === 0) return;
  await database
    .getCollection('sessions')
    .updateMany({ id: { $in: sessionIds } }, { $set: { active: false, closedReason: motivo, lastActive: new Date() } });
}

// ---------------------------------------------------------------- push

/**
 * `nativo`: qué reciben las APKs que dibujan la notificación ellas mismas (pushNativos).
 *   - undefined: lo mismo que las demás.
 *   - objeto: mensaje solo de datos (la APK arma la notificación con botones).
 *   - `soloNativos`: además, a las APKs viejas no se les manda nada (p. ej. "ya se resolvió").
 */
export async function enviarPushAUsuarios(
  sellhubUsuarioIds: string[],
  payload: { title: string; body: string; data?: Record<string, string> },
  canal: 'autorizaciones' | 'eventos' = 'autorizaciones',
  nativo?: { data: Record<string, string>; soloNativos?: boolean },
): Promise<void> {
  if (sellhubUsuarioIds.length === 0) return;
  const col = await coleccion();
  const secundarios = await coleccionSecundarios();
  const proyeccion = { projection: { pushTokens: 1, pushNativos: 1 } };
  const [vinculos, extras] = await Promise.all([
    col.find({ _id: { $in: sellhubUsuarioIds } }, proyeccion).toArray(),
    secundarios.find({ sellhubUsuarioId: { $in: sellhubUsuarioIds } }, proyeccion).toArray(),
  ]);
  const todos = [...vinculos, ...extras];
  const viejos = [...new Set(todos.flatMap((v) => v.pushTokens ?? []))];
  const nativos = [...new Set(todos.flatMap((v) => v.pushNativos ?? []))];

  const invalidos = (
    await Promise.all([
      nativo?.soloNativos ? [] : enviarPushATokens(nativo ? viejos : [...viejos, ...nativos], payload, canal),
      nativo ? enviarDatosATokens(nativos, nativo.data) : [],
    ])
  ).flat();
  if (invalidos.length > 0) {
    const quitar = { $pull: { pushTokens: { $in: invalidos }, pushNativos: { $in: invalidos } } };
    await Promise.all([col.updateMany({}, quitar), secundarios.updateMany({}, quitar)]);
  }
}

/** De una lista de usuarios de sellhub, los que tienen celular vinculado. */
export async function filtrarVinculados(sellhubUsuarioIds: string[]): Promise<string[]> {
  const vinculos = await (await coleccion()).find({ _id: { $in: sellhubUsuarioIds } }, { projection: { _id: 1 } }).toArray();
  return vinculos.map((v) => v._id);
}
