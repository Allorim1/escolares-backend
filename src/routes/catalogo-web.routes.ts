import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { Request, Response, Router } from 'express';
import { database } from '../config/database';
import { autenticarCaja, RequestCaja } from '../middlewares/autorizaciones.middleware';
import { authenticateToken } from '../middlewares/auth.middleware';
import { obtenerTasaUsdBcv } from '../services/tasa-bcv.service';
import { processDataUrlImage, deleteImageVariantsByPrefix } from '../services/image-variants.service';

/**
 * Catálogo web: productos de sellhub (EscolaresPRO) marcados con "Ver en web".
 *
 * sellhub tiene los productos en su Postgres local y las fotos en una carpeta de red,
 * que desde aquí no se alcanzan; por eso es sellhub quien envía cada producto (con su
 * foto) cuando se guarda, o todos con "Enviar todos a la web".
 *
 *   /api/catalogo-web/caja/...   sellhub (cabecera x-api-key, igual que /api/autorizaciones/caja)
 *   /api/catalogo-web/productos  público: lo que muestra la página /catalogo de la web
 *
 * Va en su propia colección (catalogo_web), separada de `products` de la tienda.
 */

const COLECCION = 'catalogo_web';
const SUBCARPETA = 'catalogo-web';
const MAX_IMAGEN_BYTES = 8 * 1024 * 1024;
const MAX_PRODUCTOS_LOTE = 5000;
const EXTENSIONES: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/gif': '.gif',
  'image/bmp': '.bmp',
};

interface ImagenCatalogo { url: string; thumb?: string | null; medium?: string | null; hash?: string | null; }
interface ProductoCatalogo {
  codigo: string;
  nombre: string;
  descripcion: string;
  categorias: string[];
  etiquetas: string[];
  precioUsd: number | null;
  existencia: number;
  imagen: string | null;
  imageThumb?: string | null;
  imageMedium?: string | null;
  imagenes?: ImagenCatalogo[];
  imageMainIndex?: number;
  imagenHash: string | null;
  actualizado: Date;
}

// Misma raíz de archivos que las fotos de `products` (products.routes.ts), servida en /api/uploads.
const uploadsRoot = process.env.UPLOADS_PATH ? path.resolve(process.env.UPLOADS_PATH) : path.resolve(process.cwd(), 'uploads');
const carpetaImagenes = path.join(uploadsRoot, SUBCARPETA);

const coleccion = () => database.getCollection<ProductoCatalogo>(COLECCION);

let indicesListos = false;
async function asegurarIndices(): Promise<void> {
  if (indicesListos) return;
  await coleccion().createIndex({ codigo: 1 }, { unique: true });
  indicesListos = true;
}

const texto = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

/** "Papelería, Oficina" → ['Papelería', 'Oficina'], sin vacíos ni repetidos (sin distinguir mayúsculas). */
function lista(v: unknown): string[] {
  const partes = Array.isArray(v) ? v.map(String) : typeof v === 'string' ? v.split(',') : [];
  const vistos = new Set<string>();
  const salida: string[] = [];
  for (const p of partes) {
    const limpio = p.trim().replace(/\s+/g, ' ').slice(0, 60);
    const clave = limpio.toLocaleLowerCase('es');
    if (limpio && !vistos.has(clave)) {
      vistos.add(clave);
      salida.push(limpio);
    }
  }
  return salida.slice(0, 30);
}

function numero(v: unknown): number | null {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** El código pasa a nombre de archivo: solo caracteres seguros. */
const codigoArchivo = (codigo: string) => codigo.replace(/[^A-Za-z0-9_-]/g, '_');

function borrarImagenes(codigo: string, salvo?: string): void {
  try {
    const prefijo = `${codigoArchivo(codigo)}-`;
    for (const f of fs.readdirSync(carpetaImagenes)) {
      if (f.startsWith(prefijo) && f !== salvo) fs.unlinkSync(path.join(carpetaImagenes, f));
    }
  } catch {
    // carpeta sin crear o archivo ya borrado
  }
}

/**
 * Guarda la foto como variantes WebP optimizadas (thumb/medium/main).
 */
async function guardarImagen(codigo: string, dataUrl: string, hashEnviado: string | null, suffix=''): Promise<{ url: string; thumb: string; medium: string; hash: string }> {
  const out = await processDataUrlImage({
    dataUrl,
    folder: SUBCARPETA,
    baseName: `${codigoArchivo(codigo)}${suffix ? `-${suffix}` : ''}`,
    hashHint: hashEnviado,
    maxBytes: MAX_IMAGEN_BYTES,
  });
  return { url: out.image, thumb: out.imageThumb || out.image, medium: out.imageMedium || out.image, hash: out.imageHash || hashEnviado || '' };
}

function normalizarImagenesInput(body: Record<string, unknown>): Array<{ dataUrl?: string|null; url?: string|null; hash?: string|null }> | null {
  const raw = body.imagenes;
  if (!Array.isArray(raw)) return null;
  return raw.slice(0, 12).map((it: any) => ({
    dataUrl: typeof it?.dataUrl === 'string' ? it.dataUrl : (typeof it?.imagen === 'string' ? it.imagen : (typeof it === 'string' ? it : null)),
    url: typeof it?.url === 'string' ? it.url : null,
    hash: typeof it?.hash === 'string' ? it.hash : (typeof it?.imagenHash === 'string' ? it.imagenHash : null),
  }));
}

async function guardarImagenesProducto(codigo: string, body: Record<string, unknown>, actual: any): Promise<{ imagen: string|null; imageThumb: string|null; imageMedium: string|null; imagenes: ImagenCatalogo[]; imageMainIndex: number; imagenHash: string|null; }> {
  const mainIndexRaw = Number(body.imageMainIndex ?? body.imagenPrincipalIndex ?? actual?.imageMainIndex ?? 0);
  const imagenesInput = normalizarImagenesInput(body);
  let imagen = actual?.imagen ?? null;
  let imageThumb = actual?.imageThumb ?? null;
  let imageMedium = actual?.imageMedium ?? null;
  let imagenHash = actual?.imagenHash ?? null;
  let imagenes: ImagenCatalogo[] = Array.isArray(actual?.imagenes) ? actual.imagenes : (imagen ? [{ url: imagen, thumb: imageThumb, medium: imageMedium, hash: imagenHash }] : []);
  let imageMainIndex = Number.isFinite(mainIndexRaw) ? Math.max(0, Math.floor(mainIndexRaw)) : 0;

  if (imagenesInput) {
    const next: ImagenCatalogo[] = [];
    for (let i = 0; i < imagenesInput.length; i++) {
      const item = imagenesInput[i];
      const prev = imagenes[i];
      const hash = item.hash && /^[a-f0-9]{8,64}$/i.test(item.hash) ? item.hash.toLowerCase() : (prev?.hash || null);
      if (typeof item.dataUrl === 'string' && item.dataUrl.startsWith('data:')) {
        if (prev?.hash && hash === prev.hash && prev.url) { next.push(prev); continue; }
        const g = await guardarImagen(codigo, item.dataUrl, hash, String(i + 1));
        next.push({ url: g.url, thumb: g.thumb, medium: g.medium, hash: g.hash });
      } else if (typeof item.url === 'string' && item.url) {
        next.push({ url: item.url, thumb: prev?.thumb || item.url, medium: prev?.medium || item.url, hash: hash || prev?.hash || null });
      } else if (prev?.url) {
        next.push(prev);
      }
    }
    imagenes = next;
    const keep = new Set(imagenes.flatMap(img => [img.url, img.thumb, img.medium].filter(Boolean).map((u:any)=>String(u).split('/').pop())));
    try {
      const prefijo = `${codigoArchivo(codigo)}-`;
      for (const f of fs.readdirSync(carpetaImagenes)) {
        if (f.startsWith(prefijo) && !keep.has(f)) fs.unlinkSync(path.join(carpetaImagenes, f));
      }
    } catch {}
  } else if (typeof body.imagen === 'string' && body.imagen) {
    const hashEnviado = typeof body.imagenHash === 'string' && /^[a-f0-9]{8,64}$/i.test(body.imagenHash) ? body.imagenHash.toLowerCase() : null;
    if (!hashEnviado || hashEnviado !== imagenHash || !imagenes.length) {
      const guardada = await guardarImagen(codigo, body.imagen, hashEnviado, '1');
      imagenes = [{ url: guardada.url, thumb: guardada.thumb, medium: guardada.medium, hash: guardada.hash }, ...imagenes.slice(1)];
      imageMainIndex = 0;
    }
  } else if (body.imagen === null) {
    borrarImagenes(codigo);
    deleteImageVariantsByPrefix(SUBCARPETA, codigoArchivo(codigo));
    imagenes = [];
    imageMainIndex = 0;
  }

  if (imagenes.length) imageMainIndex = Math.min(imageMainIndex, imagenes.length - 1);
  const main = imagenes[imageMainIndex] || imagenes[0] || null;
  imagen = main?.url || null;
  imageThumb = main?.thumb || main?.url || null;
  imageMedium = main?.medium || main?.url || null;
  imagenHash = main?.hash || null;
  return { imagen, imageThumb, imageMedium, imagenes, imageMainIndex, imagenHash };
}

/**
 * Crea o actualiza un producto. La imagen:
 *   - imagen: data URL      → se guarda, salvo que imagenHash sea el que ya está
 *   - imagen: null          → el producto ya no tiene foto
 *   - sin `imagen`          → se deja la que hay (sellhub no la reenvía si no cambió)
 */
async function guardarProducto(body: Record<string, unknown>): Promise<ProductoCatalogo> {
  const codigo = texto(body.codigo, 40);
  if (!codigo) throw new Error('Falta el c��digo del producto');
  const nombre = texto(body.nombre, 200);
  if (!nombre) throw new Error(`El producto ${codigo} no tiene nombre`);

  const actual = await coleccion().findOne({ codigo });
  const imgs = await guardarImagenesProducto(codigo, body, actual as any);

  const producto: ProductoCatalogo = {
    codigo,
    nombre,
    descripcion: texto(body.descripcion, 2000),
    categorias: lista(body.categorias),
    etiquetas: lista(body.etiquetas),
    precioUsd: numero(body.precioUsd),
    existencia: numero(body.existencia) ?? 0,
    imagen: imgs.imagen,
    imageThumb: imgs.imageThumb,
    imageMedium: imgs.imageMedium,
    imagenes: imgs.imagenes,
    imageMainIndex: imgs.imageMainIndex,
    imagenHash: imgs.imagenHash,
    actualizado: new Date(),
  };
  await coleccion().updateOne({ codigo }, { $set: producto }, { upsert: true });
  await sincronizarProductoSellhub(producto);
  return producto;
}

async function quitarProducto(codigo: string): Promise<boolean> {
  const r = await coleccion().deleteOne({ codigo });
  borrarImagenes(codigo);
  deleteImageVariantsByPrefix(SUBCARPETA, codigoArchivo(codigo));
  await despublicarProductoSellhub(codigo);
  return r.deletedCount > 0;
}

const sellhubId = (codigo: string) => `sh_${codigo.replace(/[^A-Za-z0-9_-]/g, '_')}`;

async function sincronizarProductoSellhub(p: ProductoCatalogo): Promise<void> {
  const products = database.getCollection<any>('products');
  const id = sellhubId(p.codigo);
  const existing = await products.findOne({ $or: [{ id }, { source: 'sellhub', externalCode: p.codigo }] });
  const existencia = Number(p.existencia ?? 0);
  const disponible = existencia > 0;
  const set: any = {
    id,
    source: 'sellhub',
    externalCode: p.codigo,
    sellhubCodigo: p.codigo,
    title: p.nombre,
    description: p.descripcion || '',
    category: (p.categorias && p.categorias[0]) || 'Sin categoría',
    etiquetas: p.etiquetas || [],
    price: typeof p.precioUsd === 'number' ? p.precioUsd : 0,
    image: p.imagen || '',
    imageThumb: (p as any).imageThumb || p.imagen || '',
    imageMedium: (p as any).imageMedium || p.imagen || '',
    imageHash: p.imagenHash || null,
    images: Array.isArray((p as any).imagenes) ? (p as any).imagenes.map((i:any)=>i?.url).filter(Boolean) : (p.imagen ? [p.imagen] : []),
    imageThumbs: Array.isArray((p as any).imagenes) ? (p as any).imagenes.map((i:any)=>i?.thumb||i?.url).filter(Boolean) : ((p as any).imageThumb ? [(p as any).imageThumb] : []),
    imageMediums: Array.isArray((p as any).imagenes) ? (p as any).imagenes.map((i:any)=>i?.medium||i?.url).filter(Boolean) : ((p as any).imageMedium ? [(p as any).imageMedium] : []),
    imageMainIndex: Number((p as any).imageMainIndex || 0),
    unidades: existencia,
    stock: existencia,
    existencia,
    estado: disponible ? 'disponible' : 'agotado',
    sellhubPublished: true,
    visible: true,
    sellhubSyncAt: new Date(),
    updatedAt: new Date(),
  };
  // Campos administrados por web/admin: no pisar si ya existen
  if (!existing) {
    set.rating = { rate: 0, count: 0 };
    set.marca = null;
    set.lineaId = null;
    set.linea = null;
    set.iva = false;
    set.ivaPercentage = 16;
    set.enOferta = false;
    set.ofertaPorcentaje = 0;
    set.ofertaPrecio = 0;
    set.views = 0;
    set.purchases = 0;
    set.colorido = false;
    set.colores = [];
    set.createdAt = new Date();
  } else {
    if (existing.rating) set.rating = existing.rating;
    if (existing.marca !== undefined) set.marca = existing.marca;
    if (existing.lineaId !== undefined) set.lineaId = existing.lineaId;
    if (existing.linea !== undefined) set.linea = existing.linea;
    if (existing.iva !== undefined) set.iva = existing.iva;
    if (existing.ivaPercentage !== undefined) set.ivaPercentage = existing.ivaPercentage;
    if (existing.enOferta !== undefined) set.enOferta = existing.enOferta;
    if (existing.ofertaPorcentaje !== undefined) set.ofertaPorcentaje = existing.ofertaPorcentaje;
    if (existing.ofertaPrecio !== undefined) set.ofertaPrecio = existing.ofertaPrecio;
    if (existing.fichaTecnica !== undefined) set.fichaTecnica = existing.fichaTecnica;
    if (existing.colorido !== undefined) set.colorido = existing.colorido;
    if (existing.colores !== undefined) set.colores = existing.colores;
    if (existing.productGroupId !== undefined) set.productGroupId = existing.productGroupId;
    if (existing.variantLabel !== undefined) set.variantLabel = existing.variantLabel;
    if (existing.variantKind !== undefined) set.variantKind = existing.variantKind;
    if (existing.variantSort !== undefined) set.variantSort = existing.variantSort;
    if (existing.isGroupDefault !== undefined) set.isGroupDefault = existing.isGroupDefault;
  }
  await products.updateOne({ id }, { $set: set }, { upsert: true });
}

async function despublicarProductoSellhub(codigo: string): Promise<void> {
  const products = database.getCollection<any>('products');
  await products.updateOne(
    { $or: [{ id: sellhubId(codigo) }, { source: 'sellhub', externalCode: codigo }] },
    { $set: { sellhubPublished: false, visible: false, estado: 'agotado', unidades: 0, stock: 0, existencia: 0, updatedAt: new Date() } }
  );
}

const mensaje = (e: unknown) => (e instanceof Error ? e.message : 'Error inesperado');

// ---------------------------------------------------------------- caja (sellhub)

const caja = Router();
caja.use(autenticarCaja);
// El catálogo web es de una sola tienda (se marca en Gestión Multienda): las demás no lo tocan.
caja.use((req: Request, res: Response, next) => {
  if (!(req as RequestCaja).tienda?.catalogoWeb) {
    res.status(403).json({ message: 'Esta tienda no alimenta el catálogo web (se configura en Gestión Multienda)' });
    return;
  }
  next();
});

/** Hash de la foto que tiene cada producto, para que sellhub solo envíe las que cambiaron. */
caja.get('/estado', async (_req: Request, res: Response) => {
  try {
    await asegurarIndices();
    const filas = await coleccion().find({}, { projection: { _id: 0, codigo: 1, imagenHash: 1, imagenes: 1 } }).toArray();
    res.json(filas.map((f: any) => ({
      codigo: f.codigo,
      imagenHash: f.imagenHash || null,
      imagenesHash: Array.isArray(f.imagenes) ? f.imagenes.map((i:any)=>i?.hash).filter(Boolean).join(',') : (f.imagenHash || null),
    })));
  } catch (e) {
    res.status(500).json({ message: mensaje(e) });
  }
});

caja.put('/productos/:codigo', async (req: Request, res: Response) => {
  try {
    await asegurarIndices();
    const producto = await guardarProducto({ ...(req.body ?? {}), codigo: req.params.codigo });
    res.json({ ok: true, codigo: producto.codigo, imagen: producto.imagen });
  } catch (e) {
    res.status(400).json({ message: mensaje(e) });
  }
});

caja.delete('/productos/:codigo', async (req: Request, res: Response) => {
  try {
    const quitado = await quitarProducto(String(req.params.codigo));
    res.json({ ok: true, quitado });
  } catch (e) {
    res.status(500).json({ message: mensaje(e) });
  }
});

/**
 * Sincronización completa: `codigos` es la lista de TODOS los productos que deben quedar
 * en la web; los que no estén se quitan. Los datos de cada uno se envían aparte con PUT,
 * en tandas, para no mandar cientos de fotos en una sola petición.
 */
caja.post('/conservar', async (req: Request, res: Response) => {
  try {
    const codigos = Array.isArray(req.body?.codigos) ? req.body.codigos.map((c: unknown) => texto(c, 40)).filter(Boolean) : null;
    if (!codigos || codigos.length > MAX_PRODUCTOS_LOTE) {
      res.status(400).json({ message: 'Lista de códigos inválida' });
      return;
    }
    const sobran = await coleccion()
      .find({ codigo: { $nin: codigos } }, { projection: { _id: 0, codigo: 1 } })
      .toArray();
    for (const { codigo } of sobran) await quitarProducto(codigo);
    res.json({ ok: true, quitados: sobran.length });
  } catch (e) {
    res.status(500).json({ message: mensaje(e) });
  }
});

// ---------------------------------------------------------------- público (página /catalogo)

const router = Router();
router.use('/caja', caja);

router.post('/sync-products', authenticateToken, async (req: Request, res: Response) => {
  try {
    const anyReq = req as any;
    const rol = String(anyReq.user?.rol || anyReq.userRol || '');
    const isAdmin = rol === 'root' || rol === 'admin' || rol === 'administrador' || anyReq.user?.isAdmin === true;
    const key = String(req.headers['x-admin-sync-key'] || '');
    const expected = String(process.env.ADMIN_SYNC_KEY || '');
    const hasSyncKey = !!expected && key === expected;
    if (!isAdmin && !hasSyncKey) return res.status(403).json({ error: 'No autorizado' });
    await asegurarIndices();
    const docs = await coleccion().find({}).toArray();
    let synced = 0;
    for (const d of docs) { await sincronizarProductoSellhub(d as any); synced++; }
    res.json({ ok: true, synced });
  } catch (e) {
    console.error('[catalogo-web] sync-products', e);
    res.status(500).json({ error: 'No se pudo sincronizar productos Sellhub' });
  }
});

router.get('/productos', async (_req: Request, res: Response) => {
  try {
    const productos = await coleccion()
      .find({}, { projection: { _id: 0, imagenHash: 0 } })
      .sort({ nombre: 1 })
      .toArray();
    let tasa: number | null = null;
    try {
      tasa = await obtenerTasaUsdBcv();
    } catch {
      // sin tasa la página muestra solo el precio en dólares
    }
    res.json({
      tasa,
      productos: productos.map((p) => ({
        codigo: p.codigo,
        nombre: p.nombre,
        descripcion: p.descripcion,
        categorias: p.categorias ?? [],
        etiquetas: p.etiquetas ?? [],
        precioUsd: p.precioUsd,
        disponible: (p.existencia ?? 0) > 0,
        imagen: (p as any).imageMedium || p.imagen,
        imageThumb: (p as any).imageThumb || p.imagen,
        imageMedium: (p as any).imageMedium || p.imagen,
        imagenes: Array.isArray((p as any).imagenes) ? (p as any).imagenes.map((i:any)=>({ url:i?.medium||i?.url, thumb:i?.thumb||i?.url, hash:i?.hash||null })).filter((i:any)=>i.url) : [],
        imageMainIndex: Number((p as any).imageMainIndex || 0),
      })),
    });
  } catch (e) {
    console.error('Error al obtener el catálogo web:', e);
    res.status(500).json({ message: 'Error al obtener el catálogo' });
  }
});

export default router;
