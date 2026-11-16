import crypto from 'crypto';
import { MongoServerError } from 'mongodb';
import { database } from '../config/database';
import { enviarDatosATokens, enviarPushATokens } from './push.service';
import { emitirAEscolares, sacarDeSalaUsuario, unirDispositivosASala } from './autorizaciones-socket.service';
import { idSellhub, nombreTienda, uid } from './autorizaciones-tiendas.service';

/**
 * Vínculo entre un usuario de sellhub de UNA tienda (EscolaresPRO, la app de escritorio
 * de las cajas) y el celular de su dueño con la app de supervisores (ion/escolares-pro).
 *
 *   1. En la app, la persona inicia sesión con su cuenta de escolares (/api/auth/login-app)
 *      y pide un código de vinculación de 6 dígitos (dura CODIGO_TTL_MS).
 *   2. En el sellhub de una tienda (Seguridad → Celulares), alguien con el permiso
 *      `movil_vincular` elige el usuario y escribe ese código. La tienda la dice su clave.
 *
 * Reglas (multitienda):
 *  - Una cuenta de escolares puede estar vinculada en VARIAS tiendas, un usuario por tienda,
 *    siempre en el mismo celular principal. Para sumar otra tienda, el código se pide desde
 *    ese celular.
 *  - Un usuario de sellhub (de una tienda) tiene como máximo un celular (_id = tienda:usuario).
 *  - Un celular físico (dispositivoId, generado por la app) es de una sola cuenta.
 *
 * Además, el principal puede sumar hasta MAX_SECUNDARIOS celulares secundarios con un QR
 * (ver autorizaciones-dispositivos.service.ts): son de la CUENTA, así que ven todas sus
 * tiendas. Viven en `autorizaciones_dispositivos` y se borran al quitarle a la cuenta su
 * último vínculo.
 */
export interface VinculoAutorizaciones {
  /** `tiendaId:usuarioId` (ver uid en autorizaciones-tiendas.service.ts). */
  _id: string;
  tiendaId: string;
  /** Id del usuario en el sellhub de esa tienda (main.usuarios.id en su Postgres). */
  sellhubUsuarioId: string;
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

/** Celular extra vinculado por QR desde el principal (_id = su dispositivoId). Es de la cuenta. */
export interface DispositivoSecundario {
  _id: string;
  /** Id público para listarlo y retirarlo (el dispositivoId no sale del backend). */
  id: string;
  escolaresUserId: string;
  /** Solo en registros de antes de multitienda; ya no se usa. */
  sellhubUsuarioId?: string;
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
    col.createIndex({ tiendaId: 1, escolaresUserId: 1 }, { unique: true, name: 'tienda_cuenta' }),
    col.createIndex({ escolaresUserId: 1 }, { name: 'cuenta' }),
    col.createIndex({ dispositivoId: 1 }, { name: 'dispositivo' }),
  ]).then(() => undefined);
  await indicesListos;
  return col;
}

let indicesSecundariosListos: Promise<void> | null = null;
export async function coleccionSecundarios() {
  const col = database.getCollection<DispositivoSecundario>('autorizaciones_dispositivos');
  indicesSecundariosListos ??= Promise.all([
    col.createIndex({ id: 1 }, { unique: true }),
    col.createIndex({ escolaresUserId: 1 }),
  ]).then(() => undefined);
  await indicesSecundariosListos;
  return col;
}

export async function secundarioPorDispositivo(dispositivoId: string): Promise<DispositivoSecundario | null> {
  return (await coleccionSecundarios()).findOne({ _id: dispositivoId });
}

/** Todos los vínculos de una cuenta (uno por tienda), en orden de tienda. */
export async function vinculosPorEscolares(escolaresUserId: string): Promise<VinculoAutorizaciones[]> {
  const vinculos = await (await coleccion()).find({ escolaresUserId }).toArray();
  return vinculos.sort((a, b) => nombreTienda(a.tiendaId).localeCompare(nombreTienda(b.tiendaId)));
}

/** Algún vínculo cuyo celular principal es este (todos los de una cuenta comparten celular). */
export async function vinculoPorDispositivo(dispositivoId: string): Promise<VinculoAutorizaciones | null> {
  return (await coleccion()).findOne({ dispositivoId });
}

export async function vinculoPorId(id: string): Promise<VinculoAutorizaciones | null> {
  return (await coleccion()).findOne({ _id: id });
}

/** Lo que el celular sabe de un vínculo (sin tokens push). */
export function vistaVinculo(v: VinculoAutorizaciones) {
  return {
    tiendaId: v.tiendaId,
    tiendaNombre: nombreTienda(v.tiendaId),
    sellhubNombre: v.sellhubNombre,
    dispositivoNombre: v.dispositivoNombre,
    vinculadoEn: v.vinculadoEn,
  };
}

/** Lo que ve el sellhub de una tienda: el _id es su id de usuario, como antes de multitienda. */
export function vistaVinculoCaja(v: VinculoAutorizaciones) {
  const { pushTokens: _t, pushNativos: _n, tiendaId: _tienda, sellhubUsuarioId, ...resto } = v;
  return { ...resto, _id: sellhubUsuarioId };
}

// ---------------------------------------------------------------- celular

export async function generarCodigo(datos: Omit<CodigoPendiente, 'expiraEn'>): Promise<{ codigo: string; expiraEn: Date }> {
  const propios = await vinculosPorEscolares(datos.escolaresUserId);
  // Las tiendas de una cuenta comparten celular principal: la siguiente se pide desde ese.
  if (propios.length > 0 && propios[0].dispositivoId !== datos.dispositivoId) {
    throw new ErrorAutorizaciones(
      409,
      `Tu cuenta ya está vinculada en otro celular (${propios[0].dispositivoNombre}). Para agregar otra tienda, pide el código desde ese celular.`,
    );
  }
  const delCelular = await vinculoPorDispositivo(datos.dispositivoId);
  if (delCelular && delCelular.escolaresUserId !== datos.escolaresUserId) {
    throw new ErrorAutorizaciones(409, 'Este celular ya está vinculado con otra cuenta');
  }
  if (await secundarioPorDispositivo(datos.dispositivoId)) {
    throw new ErrorAutorizaciones(409, 'Este celular es un dispositivo secundario: el código se pide desde el celular principal');
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

/** El celular principal es el mismo en todos los vínculos de la cuenta: el token va en todos. */
export async function guardarPushToken(escolaresUserId: string, pushToken: string, nativo = false): Promise<void> {
  await (await coleccion()).updateMany({ escolaresUserId }, { $set: camposToken(pushToken, nativo) });
}

export async function borrarPushTokens(escolaresUserId: string): Promise<void> {
  await (await coleccion()).updateMany({ escolaresUserId }, { $set: { pushTokens: [], pushNativos: [] } });
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

export async function vincular(codigo: string, tiendaId: string, sellhubUsuarioId: string, sellhubNombre: string): Promise<VinculoAutorizaciones> {
  const pendiente = codigoVigente(codigo);
  const col = await coleccion();
  const id = uid(tiendaId, sellhubUsuarioId);
  if (await col.findOne({ _id: id })) {
    throw new ErrorAutorizaciones(409, `${sellhubNombre} ya tiene un celular vinculado. Desvincúlalo primero.`);
  }
  const yaEnTienda = await col.findOne({ tiendaId, escolaresUserId: pendiente.escolaresUserId });
  if (yaEnTienda) {
    throw new ErrorAutorizaciones(409, `Esa cuenta ya está vinculada en esta tienda al usuario ${yaEnTienda.sellhubNombre}`);
  }
  // Entre que se pidió el código y ahora, la cuenta pudo cambiar de celular o el celular de cuenta.
  const propios = await col.find({ escolaresUserId: pendiente.escolaresUserId }).limit(1).toArray();
  if (propios[0] && propios[0].dispositivoId !== pendiente.dispositivoId) {
    throw new ErrorAutorizaciones(409, 'Esa cuenta ya está vinculada en otro celular. Pide un código nuevo desde ese celular.');
  }
  const delCelular = await col.findOne({ dispositivoId: pendiente.dispositivoId });
  if ((delCelular && delCelular.escolaresUserId !== pendiente.escolaresUserId) || (await secundarioPorDispositivo(pendiente.dispositivoId))) {
    throw new ErrorAutorizaciones(409, 'Ese celular ya está vinculado con otra cuenta');
  }

  const vinculo: VinculoAutorizaciones = {
    _id: id,
    tiendaId,
    sellhubUsuarioId,
    sellhubNombre,
    escolaresUserId: pendiente.escolaresUserId,
    escolaresNombre: pendiente.escolaresNombre,
    dispositivoId: pendiente.dispositivoId,
    dispositivoNombre: pendiente.dispositivoNombre,
    // El celular ya puede tener token de otra tienda: se copia para que le lleguen los avisos de esta.
    pushTokens: propios[0]?.pushTokens ?? [],
    pushNativos: propios[0]?.pushNativos ?? [],
    vinculadoEn: new Date(),
  };
  try {
    await col.insertOne(vinculo);
  } catch (error) {
    // El índice único (tienda, cuenta) cubre la carrera de dos vinculaciones simultáneas.
    if (error instanceof MongoServerError && error.code === 11000) {
      throw new ErrorAutorizaciones(409, 'Esa cuenta o ese usuario ya están vinculados en esta tienda');
    }
    throw error;
  }
  codigos.delete(codigo.trim());
  // El celular (y sus secundarios), si están conectados, empiezan a recibir lo de esta tienda ya.
  const secundarios = await (await coleccionSecundarios()).find({ escolaresUserId: vinculo.escolaresUserId }, { projection: { _id: 1 } }).toArray();
  unirDispositivosASala(vinculo.escolaresUserId, [vinculo.dispositivoId, ...secundarios.map((s) => s._id)], vinculo._id);
  emitirAEscolares(vinculo.escolaresUserId, 'vinculo', vistaVinculo(vinculo));
  return vinculo;
}

/** Los vínculos completos de una tienda (uso interno: incluyen el celular). */
export async function vinculosDeTienda(tiendaId: string): Promise<VinculoAutorizaciones[]> {
  return (await coleccion()).find({ tiendaId }).toArray();
}

export async function listarVinculos(tiendaId: string) {
  const vinculos = await (await coleccion()).find({ tiendaId }).sort({ sellhubNombre: 1 }).toArray();
  return vinculos.map(vistaVinculoCaja);
}

export async function desvincular(tiendaId: string, sellhubUsuarioId: string): Promise<void> {
  const col = await coleccion();
  const vinculo = await col.findOneAndDelete({ _id: uid(tiendaId, sellhubUsuarioId) });
  if (!vinculo) return;
  sacarDeSalaUsuario(vinculo._id);
  // Si la cuenta se quedó sin tiendas, los secundarios no tienen de quién colgar: se van con ella.
  const quedan = await col.countDocuments({ escolaresUserId: vinculo.escolaresUserId });
  if (quedan === 0) {
    const secundarios = await coleccionSecundarios();
    const filtro = { escolaresUserId: vinculo.escolaresUserId };
    const sesiones = (await secundarios.find(filtro, { projection: { sessionId: 1 } }).toArray()).map((d) => d.sessionId);
    await secundarios.deleteMany(filtro);
    await cerrarSesionesEscolares(sesiones, 'dispositivo_desvinculado');
  }
  emitirAEscolares(vinculo.escolaresUserId, 'vinculo:eliminado', { tiendaId, quedan });
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
 * `usuarios`: ids internos (`tienda:usuario`).
 * `nativo`: qué reciben las APKs que dibujan la notificación ellas mismas (pushNativos).
 *   - undefined: lo mismo que las demás.
 *   - objeto: mensaje solo de datos (la APK arma la notificación con botones).
 *   - `soloNativos`: además, a las APKs viejas no se les manda nada (p. ej. "ya se resolvió").
 */
export async function enviarPushAUsuarios(
  usuarios: string[],
  payload: { title: string; body: string; data?: Record<string, string> },
  canal: 'autorizaciones' | 'eventos' = 'autorizaciones',
  nativo?: { data: Record<string, string>; soloNativos?: boolean },
): Promise<void> {
  if (usuarios.length === 0) return;
  const col = await coleccion();
  const secundarios = await coleccionSecundarios();
  const vinculos = await col.find({ _id: { $in: usuarios } }, { projection: { pushTokens: 1, pushNativos: 1, escolaresUserId: 1 } }).toArray();
  const cuentas = [...new Set(vinculos.map((v) => v.escolaresUserId))];
  const extras = cuentas.length
    ? await secundarios.find({ escolaresUserId: { $in: cuentas } }, { projection: { pushTokens: 1, pushNativos: 1 } }).toArray()
    : [];
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

/** De una lista de usuarios (ids internos), los que tienen celular vinculado. */
export async function filtrarVinculados(usuarios: string[]): Promise<string[]> {
  if (usuarios.length === 0) return [];
  const vinculos = await (await coleccion()).find({ _id: { $in: usuarios } }, { projection: { _id: 1 } }).toArray();
  return vinculos.map((v) => v._id);
}

/** Para respuestas a la caja: el id simple de sellhub. */
export const aIdsSellhub = (usuarios: string[]) => usuarios.map(idSellhub);
