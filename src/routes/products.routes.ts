import express, { Request, Response } from 'express';
import { database } from '../config/database';
import { authenticateToken } from '../middlewares/auth.middleware';
import Redis from 'ioredis';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { processImageBuffer } from '../services/image-variants.service';

const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';
let redis: Redis | null = null;
try {
  redis = new Redis(redisUrl, {
    family: 4,
    lazyConnect: true,
    maxRetriesPerRequest: 3,
  });
} catch (e) {
  console.log('Redis not available for products cache');
}

const CACHE_TTL = 600;

const cacheGet = async (key: string): Promise<string | null> => {
  if (!redis) return null;
  try {
    return await redis.get(key);
  } catch {
    return null;
  }
};

const cacheSet = async (key: string, value: string, ttl: number = CACHE_TTL): Promise<void> => {
  if (!redis) return;
  try {
    await redis.setex(key, ttl, value);
  } catch (e) {
    console.log('Cache set error:', e);
  }
};

const cacheDeletePattern = async (pattern: string): Promise<void> => {
  if (!redis) return;
  try {
    const keys = await redis.keys(pattern);
    if (keys.length > 0) {
      await redis.del(...keys);
    }
  } catch {}
};

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const router = express.Router();

const defaultColors = [
  { id: '1', nombre: 'Rojo', codigoHex: '#FF0000', imagen: 'https://via.placeholder.com/150/FF0000/FFFFFF?text=Rojo' },
  { id: '2', nombre: 'Verde', codigoHex: '#00FF00', imagen: 'https://via.placeholder.com/150/00FF00/000000?text=Verde' },
  { id: '3', nombre: 'Azul', codigoHex: '#0000FF', imagen: 'https://via.placeholder.com/150/0000FF/FFFFFF?text=Azul' },
  { id: '4', nombre: 'Amarillo', codigoHex: '#FFFF00', imagen: 'https://via.placeholder.com/150/FFFF00/000000?text=Amarillo' },
  { id: '5', nombre: 'Negro', codigoHex: '#000000', imagen: 'https://via.placeholder.com/150/000000/FFFFFF?text=Negro' },
  { id: '6', nombre: 'Blanco', codigoHex: '#FFFFFF', imagen: 'https://via.placeholder.com/150/FFFFFF/000000?text=Blanco' }
];

const crearRegistro = async (database: any, accion: string, modulo: string, descripcion: string, datos: any, usuario: string) => {
  const db = database.db;
  if (!db) return;
  let registrosCollection = db.collection('registros');
  const exists = await db.listCollections().toArray();
  const names = exists.map((c: any) => c.name);
  if (!names.includes('registros')) {
    await db.createCollection('registros');
    registrosCollection = db.collection('registros');
  }
  await registrosCollection.insertOne({
    accion,
    modulo,
    descripcion,
    datos,
    usuario,
    fecha: new Date(),
  });
};

// Storage configuration for product images
const uploadsRoot = process.env.UPLOADS_PATH
  ? path.resolve(process.env.UPLOADS_PATH)
  : path.resolve(process.cwd(), 'uploads');
const productUploadPath = path.join(uploadsRoot, 'products');
if (!fs.existsSync(productUploadPath)) {
  fs.mkdirSync(productUploadPath, { recursive: true });
}
console.log('Multer product upload root:', productUploadPath);

const productImagesStorage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    cb(null, productUploadPath);
  },
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    const uniqueName = `${Date.now()}-${Math.round(Math.random() * 1E9)}${ext}`;
    cb(null, uniqueName);
  }
});

const uploadProductImage = multer({
  storage: productImagesStorage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) {
      cb(null, true);
    } else {
      cb(new Error('Solo se permiten archivos de imagen'));
    }
  }
});

async function optimizeUploadedFile(file: Express.Multer.File) {
  const buffer = fs.readFileSync(file.path);
  const baseName = path.parse(file.filename).name;
  const out = await processImageBuffer({ buffer, folder: 'products', baseName });
  try { fs.unlinkSync(file.path); } catch {}
  return out;
}

// Upload main image for a product
router.post(
  '/upload-image',
  authenticateToken,
  uploadProductImage.single('image'),
  async (req: Request, res: Response) => {
    if (!req.file) return res.status(400).json({ error: 'No se proporcionó ninguna imagen' });
    try {
      const out = await optimizeUploadedFile(req.file);
      res.json({ url: out.image, thumb: out.imageThumb, medium: out.imageMedium, image: out.image, imageThumb: out.imageThumb, imageMedium: out.imageMedium, filename: req.file.filename, originalname: req.file.originalname, size: req.file.size });
    } catch (e) {
      console.error('Error optimizing product image:', e);
      res.status(500).json({ error: 'Error al procesar imagen' });
    }
  }
);

// Upload additional images for a product
router.post(
  '/upload-images',
  authenticateToken,
  uploadProductImage.array('images', 4),
  async (req: Request, res: Response) => {
    const files = req.files as Express.Multer.File[];
    if (!files || files.length === 0) return res.status(400).json({ error: 'No se proporcionaron imágenes' });
    try {
      const outs = [] as any[];
      for (const f of files) outs.push(await optimizeUploadedFile(f));
      res.json({ urls: outs.map(o => o.image), images: outs, files: files.map(f => ({ filename: f.filename, originalname: f.originalname, size: f.size })) });
    } catch (e) {
      console.error('Error optimizing product images:', e);
      res.status(500).json({ error: 'Error al procesar imágenes' });
    }
  }
);

// Helper to process images from request
async function processRequestImages(req: Request): Promise<{ image: string; images: string[]; imageThumb?: string; imageMedium?: string; imageThumbs?: string[]; imageMediums?: string[]; imageMainIndex?: number }> {
  let image = (req.body?.image as string) || '';
  let imageThumb = (req.body?.imageThumb as string) || '';
  let imageMedium = (req.body?.imageMedium as string) || '';
  let images: string[] = [];
  const files = req.files as { [fieldname: string]: Express.Multer.File[] } | undefined;
  if (files) {
    if (files.image && files.image.length > 0) {
      const out = await optimizeUploadedFile(files.image[0]);
      image = out.image; imageThumb = out.imageThumb || out.image; imageMedium = out.imageMedium || out.image;
    }
    if (files.images && files.images.length > 0) {
      for (const f of files.images) { const out = await optimizeUploadedFile(f); images.push(out.image); }
    }
  }
  const normalizeImg = (img: string) => {
    if (!img) return '';
    if (img.startsWith('data:') || img.startsWith('http')) return img;
    const idx = img.indexOf('/api/uploads/');
    if (idx !== -1) return img.slice(idx);
    if (img.startsWith('/uploads/')) return '/api' + img;
    if (!img.includes('/')) return `/api/uploads/products/${img}`;
    return img;
  };
  if (req.body?.images) {
    const raw = typeof req.body.images === 'string' ? (()=>{ try{return JSON.parse(req.body.images)}catch{return []}})() : req.body.images;
    if (Array.isArray(raw)) images = [...images, ...raw.map((x:any)=>normalizeImg(String(x))).filter(Boolean)];
  }
  image = normalizeImg(image);
  imageThumb = normalizeImg(imageThumb);
  imageMedium = normalizeImg(imageMedium);
  return { image, images: images.map(normalizeImg).filter(Boolean), imageThumb, imageMedium };
}

function buildProductsQuery(req: Request) {
  const searchParam = (req.query.search as string | undefined)?.trim();
  const categoryParam = (req.query.category as string | undefined)?.trim();
  const brandParam = (req.query.brand as string | undefined)?.trim() || (req.query.marca as string | undefined)?.trim();
  const sourceParam = (req.query.source as string | undefined)?.trim();
  const groupIdParam = (req.query.productGroupId as string | undefined)?.trim();
  const visibleParam = req.query.visible as string | undefined;
  const minPrice = Number(req.query.minPrice);
  const maxPrice = Number(req.query.maxPrice);
  const sortParam = String(req.query.sort || 'recent');
  const query: any = {};
  const filters: any[] = [];
  if (visibleParam !== 'all') filters.push({ $or: [{ visible: { $ne: false } }, { visible: { $exists: false } }] });
  if (sourceParam) filters.push({ source: sourceParam });
  if (groupIdParam) filters.push({ productGroupId: groupIdParam });
  if (categoryParam) filters.push({ category: categoryParam });
  if (brandParam) filters.push({ marca: brandParam });
  if (Number.isFinite(minPrice)) filters.push({ price: { ...(filters.find(f=>f.price)?.price||{}), $gte: minPrice } });
  if (Number.isFinite(maxPrice)) filters.push({ price: { ...(filters.find(f=>f.price)?.price||{}), $lte: maxPrice } });
  if (searchParam) {
    const searchRegex = new RegExp(escapeRegExp(searchParam), 'i');
    filters.push({ $or: [{ title: searchRegex }, { description: searchRegex }, { category: searchRegex }, { marca: searchRegex }, { codigo: searchRegex }, { externalCode: searchRegex }, { sellhubCodigo: searchRegex }, { variantLabel: searchRegex }, { etiquetas: searchRegex }] });
  }
  if (filters.length > 0) query.$and = filters;
  const sort: any = sortParam === 'price-asc' ? { price: 1, _id: 1 }
    : sortParam === 'price-desc' ? { price: -1, _id: -1 }
    : sortParam === 'name-asc' ? { title: 1, _id: 1 }
    : sortParam === 'name-desc' ? { title: -1, _id: -1 }
    : { updatedAt: -1, createdAt: -1, _id: -1 };
  return { query, sort, searchParam, categoryParam, brandParam, sourceParam, groupIdParam, visibleParam, sortParam };
}

router.get('/facets', async (req: Request, res: Response) => {
  try {
    const { query } = buildProductsQuery(req);
    const col = database.getCollection<any>('products');
    const [cats, brands, range] = await Promise.all([
      col.aggregate([{ $match: query }, { $group: { _id: '$category', count: { $sum: 1 } } }, { $match: { _id: { $nin: [null, ''] } } }, { $sort: { _id: 1 } }]).toArray(),
      col.aggregate([{ $match: query }, { $group: { _id: '$marca', count: { $sum: 1 } } }, { $match: { _id: { $nin: [null, ''] } } }, { $sort: { _id: 1 } }]).toArray(),
      col.aggregate([{ $match: query }, { $group: { _id: null, minPrice: { $min: '$price' }, maxPrice: { $max: '$price' } } }]).toArray(),
    ]);
    res.json({
      categories: cats.map((c:any)=>({ value: String(c._id), count: c.count })),
      brands: brands.map((b:any)=>({ value: String(b._id), count: b.count })),
      price: { min: Number(range[0]?.minPrice ?? 0), max: Number(range[0]?.maxPrice ?? 0) },
    });
  } catch (error) {
    console.error('Error getting product facets:', error);
    res.status(500).json({ error: 'Error al obtener facetas de productos' });
  }
});

router.get('/', async (req: Request, res: Response) => {
  try {
    const pageParam = req.query.page as string | undefined;
    const limitParam = req.query.limit as string | undefined;
    const allParam = req.query.all as string | undefined;
    const { query, sort, searchParam, categoryParam, brandParam, sourceParam, groupIdParam, visibleParam, sortParam } = buildProductsQuery(req);

    const page = Math.max(1, parseInt(pageParam || '1', 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(limitParam || '50', 10) || 50));
    const skip = (page - 1) * limit;
    const cacheKey = `products:${page}:${limit}:${searchParam||''}:${categoryParam||''}:${brandParam||''}:${sourceParam||''}:${groupIdParam||''}:${visibleParam||''}:${sortParam}:${String(req.query.minPrice||'')}:${String(req.query.maxPrice||'')}:${allParam||''}`;
    const cached = await cacheGet(cacheKey);
    if (cached) { res.header('X-Cache', 'HIT'); return res.json(JSON.parse(cached)); }

    const projection: any = {
      title:1,price:1,description:1,category:1,image:1,imageThumb:1,imageMedium:1,images:1,imageThumbs:1,imageMediums:1,imageMainIndex:1,
      rating:1,marca:1,lineaId:1,linea:1,iva:1,ivaPercentage:1,estado:1,unidades:1,stock:1,existencia:1,enOferta:1,ofertaPorcentaje:1,ofertaPrecio:1,
      source:1,externalCode:1,sellhubCodigo:1,visible:1,sellhubPublished:1,productGroupId:1,variantLabel:1,variantKind:1,variantSort:1,isGroupDefault:1,
      etiquetas:1,fichaTecnica:1,codigo:1,createdAt:1,updatedAt:1
    };

    if (allParam === 'true') {
      const products = await database.getCollection('products').find(query).project(projection).sort(sort).toArray();
      const result = { products, total: products.length, page: 1, totalPages: 1 };
      await cacheSet(cacheKey, JSON.stringify(result), CACHE_TTL); res.header('X-Cache','MISS'); return res.json(result);
    }

    const [products, total] = await Promise.all([
      database.getCollection('products').find(query).project(projection).sort(sort).skip(skip).limit(limit).toArray(),
      database.getCollection('products').countDocuments(query)
    ]);
    const result = { products, total, page, limit, totalPages: Math.max(1, Math.ceil(total / limit)) };
    await cacheSet(cacheKey, JSON.stringify(result), CACHE_TTL);
    res.header('X-Cache', 'MISS');
    res.json(result);
  } catch (error) {
    console.error('Error getting products:', error);
    res.status(500).json({ error: 'Error al obtener productos' });
  }
});

router.get('/:id', async (req: Request, res: Response) => {
  try {
    const id = String(req.params.id);
    const cacheKey = `product:${id}`;
    const cached = await cacheGet(cacheKey);
    if (cached) {
      res.header('X-Cache', 'HIT');
      const parsed = JSON.parse(cached);
      database.getCollection('products').updateOne({ id }, { $inc: { views: 1 } }).catch(() => {});
      return res.json(parsed);
    }
    const product = await database.getCollection<any>('products').findOne({ id });
    if (!product) return res.status(404).json({ error: 'Producto no encontrado' });
    let variants: any[] = [];
    if (product.productGroupId) {
      variants = await database.getCollection<any>('products')
        .find({ productGroupId: product.productGroupId, $or: [{ visible: { $ne: false } }, { visible: { $exists: false } }] })
        .sort({ variantSort: 1, isGroupDefault: -1, title: 1 }).toArray();
    }
    const payload = { ...product, variants };
    database.getCollection('products').updateOne({ id }, { $inc: { views: 1 } }).catch(() => {});
    await cacheSet(cacheKey, JSON.stringify(payload), CACHE_TTL);
    res.header('X-Cache', 'MISS');
    res.json(payload);
  } catch (error) {
    console.error('Error getting product:', error);
    res.status(500).json({ error: 'Error al obtener producto' });
  }
});

router.get('/:id/group', async (req: Request, res: Response) => {
  try {
    const id = String(req.params.id);
    const product = await database.getCollection<any>('products').findOne({ id });
    if (!product) return res.status(404).json({ error: 'Producto no encontrado' });
    if (!product.productGroupId) return res.json({ productGroupId: null, variants: [product] });
    const variants = await database.getCollection<any>('products').find({ productGroupId: product.productGroupId }).sort({ variantSort: 1, isGroupDefault: -1, title: 1 }).toArray();
    res.json({ productGroupId: product.productGroupId, variants });
  } catch (error) {
    console.error('Error getting product group:', error);
    res.status(500).json({ error: 'Error al obtener grupo de producto' });
  }
});

router.post('/group/link', authenticateToken, async (req: Request, res: Response) => {
  try {
    const { productId, targetProductId, variantLabel, variantKind, variantSort, isGroupDefault } = req.body || {};
    if (!productId || !targetProductId) return res.status(400).json({ error: 'productId y targetProductId son requeridos' });
    const col = database.getCollection<any>('products');
    const a = await col.findOne({ id: String(productId) });
    const b = await col.findOne({ id: String(targetProductId) });
    if (!a || !b) return res.status(404).json({ error: 'Producto no encontrado' });
    const groupId = a.productGroupId || b.productGroupId || crypto.randomUUID();
    await col.updateOne({ id: a.id }, { $set: { productGroupId: groupId, variantLabel: a.variantLabel || a.title, variantKind: a.variantKind || 'modelo', isGroupDefault: a.isGroupDefault ?? true, updatedAt: new Date() } });
    await col.updateOne({ id: b.id }, { $set: { productGroupId: groupId, variantLabel: variantLabel || b.variantLabel || b.title, variantKind: variantKind || b.variantKind || 'modelo', variantSort: Number(variantSort ?? b.variantSort ?? 0), isGroupDefault: !!isGroupDefault, updatedAt: new Date() } });
    const variants = await col.find({ productGroupId: groupId }).sort({ variantSort: 1, isGroupDefault: -1, title: 1 }).toArray();
    await cacheDeletePattern('products:*'); await cacheDeletePattern(`product:${a.id}`); await cacheDeletePattern(`product:${b.id}`);
    res.json({ productGroupId: groupId, variants });
  } catch (error) {
    console.error('Error linking product group:', error);
    res.status(500).json({ error: 'Error al agrupar productos' });
  }
});

router.post('/group/unlink', authenticateToken, async (req: Request, res: Response) => {
  try {
    const { productId } = req.body || {};
    if (!productId) return res.status(400).json({ error: 'productId requerido' });
    const col = database.getCollection<any>('products');
    const p = await col.findOne({ id: String(productId) });
    if (!p) return res.status(404).json({ error: 'Producto no encontrado' });
    const groupId = p.productGroupId;
    await col.updateOne({ id: p.id }, { $set: { productGroupId: null, variantLabel: null, variantKind: null, variantSort: 0, isGroupDefault: false, updatedAt: new Date() } });
    if (groupId) {
      const remaining = await col.find({ productGroupId: groupId }).sort({ variantSort: 1, isGroupDefault: -1, title: 1 }).toArray();
      if (remaining.length === 1) {
        await col.updateOne({ id: remaining[0].id }, { $set: { productGroupId: null, variantLabel: null, variantKind: null, variantSort: 0, isGroupDefault: false, updatedAt: new Date() } });
      } else if (remaining.length > 1 && !remaining.some(v => v.isGroupDefault)) {
        await col.updateOne({ id: remaining[0].id }, { $set: { isGroupDefault: true } });
      }
    }
    await cacheDeletePattern('products:*'); await cacheDeletePattern(`product:${productId}`);
    res.json({ ok: true });
  } catch (error) {
    console.error('Error unlinking product group:', error);
    res.status(500).json({ error: 'Error al quitar producto del grupo' });
  }
});

// Create product with optional file uploads
router.post('/', authenticateToken, (req: Request, res: Response) => {
  const contentType = req.headers['content-type'] || '';
  const isMultipart = contentType.includes('multipart/form-data');
  
  if (isMultipart) {
    uploadProductImage.fields([
      { name: 'image', maxCount: 1 },
      { name: 'images', maxCount: 4 }
    ])(req, res, async (err) => {
      if (err) {
        console.error('Error uploading product images on create:', err);
        if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') {
          return res.status(400).json({ error: 'Una imagen excede el límite de 5MB' });
        }
        return res.status(400).json({ error: err.message || 'Error al subir las imágenes' });
      }
      await handleCreateProduct(req, res);
    });
  } else {
    handleCreateProduct(req, res);
  }
});

async function handleCreateProduct(req: Request, res: Response) {
  try {
    let { image, images, imageThumb, imageMedium, imageThumbs, imageMediums, imageMainIndex } = await processRequestImages(req);
    const body = req.body as any;
    const title = (body.title || '').toString().trim();
    const category = (body.category || '').toString().trim();
    const { price, description, marca, lineaId, iva, ivaPercentage, estado, enOferta, ofertaPorcentaje, ofertaPrecio, rating, colorido, colores, codigo, unidades, stock, source, externalCode, visible, sellhubPublished, productGroupId, variantLabel, variantKind, variantSort, isGroupDefault, fichaTecnica, etiquetas } = body as any;
    const usuario = req.user?.nombre || req.user?.username || req.user?.email || 'Sistema';

    if (!title) {
      return res.status(400).json({ error: 'El título del producto es obligatorio' });
    }

    const existingProduct = await database.getCollection('products').findOne({
      title: { $regex: `^${escapeRegExp(title)}$`, $options: 'i' }
    });
    if (existingProduct) {
      return res.status(409).json({ error: `Ya existe un producto con el nombre "${title}"` });
    }

    const allProductIds = await database.getCollection('products')
      .distinct('id');
    
    let maxId = 0;
    if (allProductIds.length > 0) {
      const numericIds = allProductIds
        .map(id => Number(id))
        .filter(id => !isNaN(id));
      maxId = numericIds.length > 0 ? Math.max(...numericIds) : 0;
    }
    
    let newId = String(maxId + 1);
    while (allProductIds.includes(newId)) {
      newId = String(Number(newId) + 1);
    }

    const stockVal = Number(unidades ?? stock ?? body.existencia ?? 0);
    const newProduct: any = {
      id: externalCode && (source === 'sellhub') ? `sh_${String(externalCode).replace(/[^A-Za-z0-9_-]/g,'_')}` : newId,
      title,
      price: Number(price),
      description,
      category: category || 'Sin categoría',
      image: image || '',
      imageThumb: imageThumb || image || '',
      imageMedium: imageMedium || image || '',
      images: images || [],
      imageThumbs: imageThumbs || [],
      imageMediums: imageMediums || [],
      imageMainIndex: Number(imageMainIndex || 0),
      rating: rating || { rate: 0, count: 0 },
      marca: marca || null,
      lineaId: lineaId || null,
      iva: iva || false,
      ivaPercentage: ivaPercentage || 16,
      estado: estado || (stockVal > 0 ? 'disponible' : 'agotado'),
      unidades: stockVal,
      stock: stockVal,
      existencia: stockVal,
      enOferta: enOferta || false,
      ofertaPorcentaje: ofertaPorcentaje || 0,
      ofertaPrecio: ofertaPrecio || 0,
      views: 0,
      purchases: 0,
      ...(codigo ? { codigo } : {}),
      colorido: colorido || false,
      colores: colores && colores.length > 0 ? colores : defaultColors,
      source: source || 'local',
      ...(externalCode ? { externalCode, sellhubCodigo: externalCode } : {}),
      visible: visible !== false,
      sellhubPublished: sellhubPublished !== false,
      ...(productGroupId ? { productGroupId } : {}),
      ...(variantLabel ? { variantLabel } : {}),
      ...(variantKind ? { variantKind } : {}),
      ...(variantSort !== undefined ? { variantSort: Number(variantSort) } : {}),
      ...(isGroupDefault !== undefined ? { isGroupDefault: !!isGroupDefault } : {}),
      ...(fichaTecnica ? { fichaTecnica } : {}),
      ...(Array.isArray(etiquetas) ? { etiquetas } : {}),
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    await database.getCollection('products').insertOne(newProduct);
      console.log('Product created in DB:', { id: newProduct.id, title: newProduct.title, image: image });

    if (lineaId) {
      await database.getCollection('lineas').updateOne(
        { id: lineaId },
        { $addToSet: { productIds: newId } }
      );
    }

    await crearRegistro(database, 'Creación', 'Productos', `Producto creado: ${title}`, { producto: newProduct }, usuario);

    // Invalidate product caches after successful operations
    await cacheDeletePattern('products:*');
    await cacheDeletePattern('product:*');

    res.status(201).json(newProduct);
  } catch (error) {
    console.error('Error creating product:', error);
    res.status(500).json({ error: 'Error al crear producto' });
  }
}

// Update product with optional file uploads
router.put('/:id', authenticateToken, (req: Request, res: Response) => {
  const contentType = req.headers['content-type'] || '';
  const isMultipart = contentType.includes('multipart/form-data');
  
  if (isMultipart) {
    uploadProductImage.fields([
      { name: 'image', maxCount: 1 },
      { name: 'images', maxCount: 4 }
    ])(req, res, async (err) => {
      if (err) {
        console.error('Error uploading product images on update:', err);
        if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') {
          return res.status(400).json({ error: 'Una imagen excede el límite de 5MB' });
        }
        return res.status(400).json({ error: err.message || 'Error al subir las imágenes' });
      }
      await handleUpdateProduct(req, res);
    });
  } else {
    handleUpdateProduct(req, res);
  }
});

async function handleUpdateProduct(req: Request, res: Response) {
  try {
    const id = String(req.params.id);
    let { image, images, imageThumb, imageMedium, imageThumbs, imageMediums, imageMainIndex } = await processRequestImages(req);
    const body = req.body as any;
    const title = (body.title || '').toString().trim();
    const category = (body.category || '').toString().trim();
    const { price, description, marca, iva, ivaPercentage, estado, lineaId, enOferta, ofertaPorcentaje, ofertaPrecio, colorido, colores, rating, codigo, unidades, stock, existencia, visible, sellhubPublished, productGroupId, variantLabel, variantKind, variantSort, isGroupDefault, fichaTecnica, etiquetas, source } = body;
    const usuario = req.user?.nombre || req.user?.username || req.user?.email || 'Sistema';

    const productoAnterior = await database.getCollection('products').findOne({ id });
    if (!productoAnterior) {
      return res.status(404).json({ error: 'Producto no encontrado' });
    }

    if (!title) {
      return res.status(400).json({ error: 'El título del producto es obligatorio' });
    }

    if (title !== productoAnterior.title?.toString().trim()) {
      const existingProduct = await database.getCollection('products').findOne({ 
        title: { $regex: `^${escapeRegExp(title)}$`, $options: 'i' },
        id: { $ne: id }
      });
      if (existingProduct) {
        return res.status(409).json({ error: `Ya existe un producto con el nombre "${title}"` });
      }
    }

    const updateData: any = {
      title,
      price: Number(price),
      description,
      category: category || ' ',
      image,
      marca: marca || null,
      iva: iva || false,
      ivaPercentage: ivaPercentage || 16,
      estado: estado || 'disponible',
      enOferta: enOferta || false,
      ofertaPorcentaje: ofertaPorcentaje || 0,
      ofertaPrecio: ofertaPrecio || 0,
      rating: rating || { rate: 0, count: 0 },
      ...(images.length > 0 && { images }),
      ...(lineaId !== undefined && { lineaId }),
      colorido: colorido || false,
      colores: colores && colores.length > 0 ? colores : defaultColors,
      ...(codigo !== undefined && { codigo }),
    };

    const updateResult = await database.getCollection('products').updateOne(
      { id },
      { $set: updateData }
    );
    console.log('Product update result:', { id, matchedCount: updateResult.matchedCount, modifiedCount: updateResult.modifiedCount });

    const updated = await database.getCollection('products').findOne({ id });

    // Invalidate product caches
    await cacheDeletePattern('products:*');
    await cacheDeletePattern(`product:${id}`);
    await cacheDeletePattern('req:/api/products*');

    await crearRegistro(database, 'Modificación', 'Productos', `Producto modificado: ${title}`, { productoAnterior, productoNuevo: updated }, usuario);

    res.json(updated);
  } catch (error) {
    console.error('Error updating product:', error);
    res.status(500).json({ error: 'Error al actualizar producto' });
  }
}

router.delete('/:id', authenticateToken, async (req: Request, res: Response) => {
  try {
    const id = String(req.params.id);
    const usuario = req.user?.nombre || req.user?.username || req.user?.email || 'Sistema';
    
    const productoEliminado = await database.getCollection('products').findOne({ id });
    
    await database.getCollection('products').deleteOne({ id });
    
    // Invalidate product caches
    await cacheDeletePattern('products:*');
    await cacheDeletePattern(`product:${id}`);
    await cacheDeletePattern('req:/api/products*');
    
    if (productoEliminado) {
      await crearRegistro(database, 'Eliminación', 'Productos', `Producto eliminado: ${productoEliminado.title}`, { producto: productoEliminado }, usuario);
    }
    
    res.json({ success: true });
  } catch (error) {
    console.error('Error deleting product:', error);
    res.status(500).json({ error: 'Error al eliminar producto' });
  }
});

export default router;
