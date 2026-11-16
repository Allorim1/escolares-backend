import crypto from 'crypto';
import { database } from '../config/database';

/**
 * Multitienda: cada tienda tiene su propio servidor de sellhub (su base de datos, su
 * inventario y sus usuarios) y se identifica ante este backend con SU clave (cabecera
 * x-api-key = AUTORIZACION_MOVIL_API_KEY en el .env de ese servidor). Se administran
 * desde la app de escritorio Gestión Multienda (rutas /api/multitienda, solo root).
 *
 * Los usuarios de sellhub se repiten entre tiendas (el usuario 5 de una no es el 5 de
 * otra), así que por dentro se identifican como `tiendaId:usuarioId` (ver `uid`). Hacia
 * cada sellhub se devuelve el id simple, como siempre.
 *
 * La clave nunca se guarda: solo su SHA-256 (es aleatoria y larga, no hace falta más) y
 * los últimos 4 caracteres para reconocerla. Se muestra una sola vez, al crearla.
 */
export interface Tienda {
  _id: string;
  nombre: string;
  rif: string | null;
  claveHash: string;
  /** Últimos 4 caracteres de la clave, para reconocerla en Gestión Multienda. */
  claveFinal: string;
  activa: boolean;
  /** La única tienda cuyo sellhub alimenta el catálogo web (/catalogo). */
  catalogoWeb: boolean;
  creadaEn: Date;
  actualizadaEn: Date;
}

export type TiendaPublica = Omit<Tienda, 'claveHash'>;

const coleccion = () => database.getCollection<Tienda>('autorizaciones_tiendas');

export const hashClave = (clave: string) => crypto.createHash('sha256').update(clave, 'utf8').digest('hex');
const nuevaClave = () => `tnd_${crypto.randomBytes(32).toString('base64url')}`;
export const vistaTienda = ({ claveHash: _hash, ...resto }: Tienda): TiendaPublica => resto;

// ---------------------------------------------------------------- ids de usuario

/** Id interno de un usuario de sellhub: `tiendaId:usuarioId`. */
export const uid = (tiendaId: string, sellhubUsuarioId: string | number) => `${tiendaId}:${sellhubUsuarioId}`;
/** Id simple de sellhub a partir del interno (lo que se le devuelve a la tienda). */
export const idSellhub = (u: string) => u.slice(u.indexOf(':') + 1);
/** Tienda de un id interno. */
export const tiendaDeUid = (u: string) => u.slice(0, u.indexOf(':'));

// ---------------------------------------------------------------- caché

/** Todas las tiendas en memoria: se consultan en cada llamada de las cajas. */
let cache: Map<string, Tienda> | null = null;
let cacheEn = 0;
const VIGENCIA_CACHE_MS = 30_000;

async function cargar(): Promise<Map<string, Tienda>> {
  if (!cache || Date.now() - cacheEn > VIGENCIA_CACHE_MS) {
    const todas = await coleccion().find({}).toArray();
    cache = new Map(todas.map((t) => [t._id, t]));
    cacheEn = Date.now();
  }
  return cache;
}

/** Vencido, pero sin borrarlo: los nombres se siguen viendo hasta la próxima carga. */
const invalidar = () => {
  cacheEn = 0;
};

/** Nombre de la tienda para mostrar (síncrono, del caché; la carga la hace cualquier llamada). */
export function nombreTienda(tiendaId: string): string {
  return cache?.get(tiendaId)?.nombre ?? 'Tienda';
}

/** Con una sola tienda activa no se antepone el nombre en los avisos (se ven como siempre). */
export function prefijoTienda(tiendaId: string): string {
  const activas = [...(cache?.values() ?? [])].filter((t) => t.activa).length;
  return activas > 1 ? `${nombreTienda(tiendaId)} · ` : '';
}

export async function tiendaPorClave(clave: string): Promise<Tienda | null> {
  if (!clave) return null;
  const hash = hashClave(clave);
  const tiendas = await cargar();
  for (const t of tiendas.values()) {
    if (t.claveHash.length === hash.length && crypto.timingSafeEqual(Buffer.from(t.claveHash), Buffer.from(hash))) {
      return t.activa ? t : null;
    }
  }
  return null;
}

export async function tiendaPorId(id: string): Promise<Tienda | null> {
  return (await cargar()).get(id) ?? null;
}

export async function listarTiendas(): Promise<Tienda[]> {
  return [...(await cargar()).values()].sort((a, b) => a.nombre.localeCompare(b.nombre));
}

// ---------------------------------------------------------------- administración

export class ErrorTiendas extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

const textoLimpio = (v: unknown, max: number): string | null => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);

async function nombreLibre(nombre: string, exceptoId?: string): Promise<void> {
  const repetida = [...(await cargar()).values()].find((t) => t._id !== exceptoId && t.nombre.toLowerCase() === nombre.toLowerCase());
  if (repetida) throw new ErrorTiendas(409, `Ya existe una tienda llamada ${repetida.nombre}`);
}

/** El catálogo web es de una sola tienda: marcar una desmarca las demás. */
async function soloEstaConCatalogo(tiendaId: string): Promise<void> {
  await coleccion().updateMany({ _id: { $ne: tiendaId }, catalogoWeb: true }, { $set: { catalogoWeb: false, actualizadaEn: new Date() } });
}

export async function crearTienda(input: Record<string, unknown>): Promise<{ tienda: TiendaPublica; clave: string }> {
  const nombre = textoLimpio(input.nombre, 80);
  if (!nombre) throw new ErrorTiendas(400, 'Escribe el nombre de la tienda');
  await nombreLibre(nombre);
  const clave = nuevaClave();
  const ahora = new Date();
  const tienda: Tienda = {
    _id: crypto.randomUUID(),
    nombre,
    rif: textoLimpio(input.rif, 20),
    claveHash: hashClave(clave),
    claveFinal: clave.slice(-4),
    activa: true,
    catalogoWeb: input.catalogoWeb === true,
    creadaEn: ahora,
    actualizadaEn: ahora,
  };
  if (tienda.catalogoWeb) await soloEstaConCatalogo(tienda._id);
  await coleccion().insertOne(tienda);
  invalidar();
  return { tienda: vistaTienda(tienda), clave };
}

export async function actualizarTienda(id: string, input: Record<string, unknown>): Promise<TiendaPublica> {
  const actual = await tiendaPorId(id);
  if (!actual) throw new ErrorTiendas(404, 'La tienda no existe');
  const cambios: Partial<Tienda> = { actualizadaEn: new Date() };
  if (input.nombre !== undefined) {
    const nombre = textoLimpio(input.nombre, 80);
    if (!nombre) throw new ErrorTiendas(400, 'El nombre no puede quedar vacío');
    await nombreLibre(nombre, id);
    cambios.nombre = nombre;
  }
  if (input.rif !== undefined) cambios.rif = textoLimpio(input.rif, 20);
  if (typeof input.activa === 'boolean') cambios.activa = input.activa;
  if (typeof input.catalogoWeb === 'boolean') {
    cambios.catalogoWeb = input.catalogoWeb;
    if (input.catalogoWeb) await soloEstaConCatalogo(id);
  }
  await coleccion().updateOne({ _id: id }, { $set: cambios });
  invalidar();
  return vistaTienda({ ...actual, ...cambios });
}

/** Clave nueva: la anterior deja de servir al instante (hay que ponerla en el .env de esa tienda). */
export async function regenerarClave(id: string): Promise<{ clave: string; tienda: TiendaPublica }> {
  const actual = await tiendaPorId(id);
  if (!actual) throw new ErrorTiendas(404, 'La tienda no existe');
  const clave = nuevaClave();
  const cambios = { claveHash: hashClave(clave), claveFinal: clave.slice(-4), actualizadaEn: new Date() };
  await coleccion().updateOne({ _id: id }, { $set: cambios });
  invalidar();
  return { clave, tienda: vistaTienda({ ...actual, ...cambios }) };
}

// ---------------------------------------------------------------- migración de una tienda a varias

const migraciones = () => database.getCollection<{ _id: string; hechaEn: Date; tiendaId: string | null }>('autorizaciones_migraciones');

async function borrarIndiceSiExiste(nombreColeccion: string, indice: string): Promise<void> {
  try {
    await database.getCollection(nombreColeccion).dropIndex(indice);
  } catch {
    // No existía.
  }
}

/**
 * Una sola vez: los datos de antes eran de una única tienda (la de
 * AUTORIZACIONES_SELLHUB_API_KEY). Se crea esa tienda con la misma clave (así los
 * sellhub instalados siguen funcionando sin tocar nada) y todo pasa a ser suyo:
 * vínculos, historial, notificaciones, "limpiar notificaciones" y el resumen.
 */
async function migrarAMultitienda(): Promise<void> {
  if (await migraciones().findOne({ _id: 'multitienda' })) return;

  const claveVieja = process.env.AUTORIZACIONES_SELLHUB_API_KEY || '';
  // Si una migración anterior se cortó a medias, la tienda ya existe: se sigue con ella.
  let tiendaId: string | null = claveVieja ? ((await coleccion().findOne({ claveHash: hashClave(claveVieja) }))?._id ?? null) : null;
  if (!tiendaId && (await coleccion().countDocuments()) === 0 && claveVieja) {
    const ahora = new Date();
    tiendaId = crypto.randomUUID();
    await coleccion().insertOne({
      _id: tiendaId,
      nombre: process.env.AUTORIZACIONES_TIENDA_NOMBRE?.trim() || 'Tienda principal',
      rif: null,
      claveHash: hashClave(claveVieja),
      claveFinal: claveVieja.slice(-4),
      activa: true,
      // El catálogo web lo alimentaba esta tienda.
      catalogoWeb: true,
      creadaEn: ahora,
      actualizadaEn: ahora,
    });
    invalidar();
  }

  // Los índices únicos de antes (una cuenta y un celular por vínculo) ya no aplican: una
  // cuenta tiene un vínculo por tienda, todos en el mismo celular.
  await borrarIndiceSiExiste('autorizaciones_vinculos', 'escolaresUserId_1');
  await borrarIndiceSiExiste('autorizaciones_vinculos', 'dispositivoId_1');
  await borrarIndiceSiExiste('autorizaciones_dispositivos', 'sellhubUsuarioId_1');

  if (tiendaId) {
    const prefijo = `${tiendaId}:`;
    const vinculos = database.getCollection<Record<string, unknown> & { _id: string }>('autorizaciones_vinculos');
    const viejos = await vinculos.find({ tiendaId: { $exists: false } }).toArray();
    const cuentaDe = new Map<string, string>();
    for (const v of viejos) {
      cuentaDe.set(v._id, String(v.escolaresUserId));
      // replaceOne + upsert: si se cortó a medias, al repetir no choca con la copia ya hecha.
      await vinculos.replaceOne({ _id: prefijo + v._id }, { ...v, _id: prefijo + v._id, tiendaId, sellhubUsuarioId: v._id }, { upsert: true });
      await vinculos.deleteOne({ _id: v._id });
    }

    const conPrefijo = [{ $set: { tiendaId, destinatarios: { $map: { input: '$destinatarios', in: { $concat: [prefijo, '$$this'] } } } } }];
    await database.getCollection('autorizaciones_historial').updateMany({ tiendaId: { $exists: false } }, conPrefijo);
    await database.getCollection('autorizaciones_eventos').updateMany({ tiendaId: { $exists: false } }, conPrefijo);

    // "Limpiar notificaciones" pasa a ser de la cuenta (vale para todas sus tiendas).
    const limpiezas = database.getCollection<{ _id: string; hasta: Date }>('autorizaciones_eventos_limpiados');
    for (const l of await limpiezas.find({}).toArray()) {
      const cuenta = cuentaDe.get(l._id);
      if (!cuenta) continue;
      await limpiezas.updateOne({ _id: `cuenta:${cuenta}` }, { $max: { hasta: l.hasta } }, { upsert: true });
      await limpiezas.deleteOne({ _id: l._id });
    }

    const paneles = database.getCollection<Record<string, unknown> & { _id: string }>('autorizaciones_panel');
    const panelViejo = await paneles.findOne({ _id: 'actual' });
    if (panelViejo) {
      await paneles.replaceOne({ _id: tiendaId }, { ...panelViejo, _id: tiendaId }, { upsert: true });
      await paneles.deleteOne({ _id: 'actual' });
    }
  }

  await migraciones().insertOne({ _id: 'multitienda', hechaEn: new Date(), tiendaId });
  if (tiendaId) console.log(`Autorizaciones: datos migrados a la tienda ${tiendaId} (multitienda).`);
}

let preparado: Promise<void> | null = null;

/** Índices, migración y caché. Las rutas la esperan antes de atender. */
export function prepararMultitienda(): Promise<void> {
  preparado ??= (async () => {
    await coleccion().createIndex({ claveHash: 1 }, { unique: true });
    await migrarAMultitienda();
    await cargar();
  })().catch((error) => {
    preparado = null;
    throw error;
  });
  return preparado;
}
