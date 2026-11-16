import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { Request, Response, Router } from 'express';
import { database } from '../config/database';
import { autenticarCaja, RequestCaja } from '../middlewares/autorizaciones.middleware';
import { obtenerTasaUsdBcv } from '../services/tasa-bcv.service';

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

interface ProductoCatalogo {
  codigo: string;
  nombre: string;
  descripcion: string;
  categorias: string[];
  etiquetas: string[];
  precioUsd: number | null;
  existencia: number;
  imagen: string | null;
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
 * Guarda la foto (data URL) con el hash en el nombre, para que el navegador no muestre
 * la vieja cuando cambia. Devuelve la URL pública y el hash.
 */
function guardarImagen(codigo: string, dataUrl: string, hashEnviado: string | null): { url: string; hash: string } {
  const m = /^data:(image\/[a-z]+);base64,(.+)$/i.exec(dataUrl);
  if (!m) throw new Error('Imagen inválida');
  const ext = EXTENSIONES[m[1].toLowerCase()];
  if (!ext) throw new Error('Formato de imagen no admitido');
  const buffer = Buffer.from(m[2], 'base64');
  if (!buffer.length || buffer.length > MAX_IMAGEN_BYTES) throw new Error('La imagen está vacía o pesa más de 8 MB');

  // sellhub envía el hash de la foto original (la que manda puede ir reducida), para
  // poder comparar después sin reenviarla.
  const hash = hashEnviado ?? crypto.createHash('sha1').update(buffer).digest('hex').slice(0, 12);
  const nombre = `${codigoArchivo(codigo)}-${hash}${ext}`;
  fs.mkdirSync(carpetaImagenes, { recursive: true });
  fs.writeFileSync(path.join(carpetaImagenes, nombre), buffer);
  borrarImagenes(codigo, nombre);
  return { url: `/api/uploads/${SUBCARPETA}/${nombre}`, hash };
}

/**
 * Crea o actualiza un producto. La imagen:
 *   - imagen: data URL      → se guarda, salvo que imagenHash sea el que ya está
 *   - imagen: null          → el producto ya no tiene foto
 *   - sin `imagen`          → se deja la que hay (sellhub no la reenvía si no cambió)
 */
async function guardarProducto(body: Record<string, unknown>): Promise<ProductoCatalogo> {
  const codigo = texto(body.codigo, 40);
  if (!codigo) throw new Error('Falta el código del producto');
  const nombre = texto(body.nombre, 200);
  if (!nombre) throw new Error(`El producto ${codigo} no tiene nombre`);

  const actual = await coleccion().findOne({ codigo });
  let imagen = actual?.imagen ?? null;
  let imagenHash = actual?.imagenHash ?? null;
  const hashEnviado = typeof body.imagenHash === 'string' && /^[a-f0-9]{8,64}$/i.test(body.imagenHash) ? body.imagenHash.toLowerCase() : null;

  if (typeof body.imagen === 'string' && body.imagen) {
    if (!hashEnviado || hashEnviado !== imagenHash) {
      const guardada = guardarImagen(codigo, body.imagen, hashEnviado);
      imagen = guardada.url;
      imagenHash = guardada.hash;
    }
  } else if (body.imagen === null) {
    borrarImagenes(codigo);
    imagen = null;
    imagenHash = null;
  }

  const producto: ProductoCatalogo = {
    codigo,
    nombre,
    descripcion: texto(body.descripcion, 2000),
    categorias: lista(body.categorias),
    etiquetas: lista(body.etiquetas),
    precioUsd: numero(body.precioUsd),
    existencia: numero(body.existencia) ?? 0,
    imagen,
    imagenHash,
    actualizado: new Date(),
  };
  await coleccion().updateOne({ codigo }, { $set: producto }, { upsert: true });
  return producto;
}

async function quitarProducto(codigo: string): Promise<boolean> {
  const r = await coleccion().deleteOne({ codigo });
  borrarImagenes(codigo);
  return r.deletedCount > 0;
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
    const filas = await coleccion().find({}, { projection: { _id: 0, codigo: 1, imagenHash: 1 } }).toArray();
    res.json(filas);
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
        imagen: p.imagen,
      })),
    });
  } catch (e) {
    console.error('Error al obtener el catálogo web:', e);
    res.status(500).json({ message: 'Error al obtener el catálogo' });
  }
});

export default router;
