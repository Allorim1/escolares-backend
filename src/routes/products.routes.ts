import express, { Request, Response } from 'express';
import { database } from '../config/database';
import { authenticateToken } from '../middlewares/auth.middleware';
import Redis from 'ioredis';
import multer from 'multer';
import path from 'path';
import fs from 'fs';

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
const productImagesStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    const uploadPath = path.join(__dirname, '..', 'uploads', 'products');
    if (!fs.existsSync(uploadPath)) {
      fs.mkdirSync(uploadPath, { recursive: true });
    }
    cb(null, uploadPath);
  },
  filename: (req, file, cb) => {
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

// Upload main image for a product
router.post('/upload-image', authenticateToken, (req: Request, res: Response) => {
  uploadProductImage.single('image')(req, res, (err) => {
    if (err) {
      console.error('Error uploading product image:', err);
      if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') {
        return res.status(400).json({ error: 'La imagen no puede pesar más de 5MB' });
      }
      return res.status(400).json({ error: err.message || 'Error al subir la imagen' });
    }

    if (!req.file) {
      return res.status(400).json({ error: 'No se proporcionó ninguna imagen' });
    }

    const imageUrl = `${req.protocol}://${req.get('host')}/uploads/products/${req.file.filename}`;
    res.json({ url: imageUrl, filename: req.file.originalname, size: req.file.size });
  });
});

// Upload additional images for a product
router.post('/upload-images', authenticateToken, (req: Request, res: Response) => {
  uploadProductImage.array('images', 4)(req, res, (err) => {
    if (err) {
      console.error('Error uploading product images:', err);
      if (err instanceof multer.MulterError) {
        if (err.code === 'LIMIT_FILE_SIZE') {
          return res.status(400).json({ error: 'Alguna imagen excede el límite de 5MB' });
        }
        if (err.code === 'LIMIT_FILE_COUNT') {
          return res.status(400).json({ error: 'Máximo 4 imágenes adicionales permitidas' });
        }
      }
      return res.status(400).json({ error: err.message || 'Error al subir las imágenes' });
    }

    const files = req.files as Express.Multer.File[];
    if (!files || files.length === 0) {
      return res.status(400).json({ error: 'No se proporcionaron imágenes' });
    }

    const urls = files.map(f => `${req.protocol}://${req.get('host')}/uploads/products/${f.filename}`);
    res.json({ urls, files: files.map(f => ({ filename: f.originalname, size: f.size })) });
  });
});

// Helper to process images from request
function processRequestImages(req: Request): { image: string; images: string[] } {
  let image = (req.body?.image as string) || '';
  let images: string[] = [];
  
  const files = req.files as { [fieldname: string]: Express.Multer.File[] } | undefined;
  
  if (files) {
    if (files.image && files.image.length > 0) {
      image = `${req.protocol}://${req.get('host')}/uploads/products/${files.image[0].filename}`;
    }
    if (files.images && files.images.length > 0) {
      images = files.images.map(f => `${req.protocol}://${req.get('host')}/uploads/products/${f.filename}`);
    }
  }
  
  // Handle existing images from body (backward compatibility for URLs)
  if (req.body?.images) {
    if (typeof req.body.images === 'string') {
      try {
        const parsed = JSON.parse(req.body.images);
        if (Array.isArray(parsed)) {
          images = [...images, ...parsed.filter((img: string) => 
            img.startsWith('http') || img.startsWith('https') || img.startsWith('data:image')
          )];
        }
      } catch (e) {
        // Not valid JSON, ignore
      }
    } else if (Array.isArray(req.body.images)) {
      images = [...images, ...req.body.images.filter((img: string) => 
        img.startsWith('http') || img.startsWith('https') || img.startsWith('data:image')
      )];
    }
  }
  
  return { image, images };
}

router.get('/', async (req: Request, res: Response) => {
  try {
    const pageParam = req.query.page as string | undefined;
    const limitParam = req.query.limit as string | undefined;
    const allParam = req.query.all as string | undefined;

    if (allParam === 'true') {
      const cacheKey = 'products:all';
      const cached = await cacheGet(cacheKey);
      if (cached) {
        res.header('X-Cache', 'HIT');
        return res.json(JSON.parse(cached));
      }

      const products = await database.getCollection('products').find({}).toArray();
      const result = {
        products,
        total: products.length
      };

      await cacheSet(cacheKey, JSON.stringify(result), CACHE_TTL);
      res.header('X-Cache', 'MISS');
      return res.json(result);
    }

    const page = parseInt(pageParam || '1');
    const limit = parseInt(limitParam || '50');
    const skip = (page - 1) * limit;

    const cacheKey = `products:${page}:${limit}`;
    const cached = await cacheGet(cacheKey);
    if (cached) {
      res.header('X-Cache', 'HIT');
      return res.json(JSON.parse(cached));
    }

    const [products, total] = await Promise.all([
      database.getCollection('products').find({}).skip(skip).limit(limit).toArray(),
      database.getCollection('products').countDocuments()
    ]);

    const result = {
      products,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit)
      }
    };
    
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
    const { id } = req.params;
    
    const cacheKey = `product:${id}`;
    const cached = await cacheGet(cacheKey);
    if (cached) {
      res.header('X-Cache', 'HIT');
      return res.json(JSON.parse(cached));
    }
    
    const product = await database.getCollection('products').findOne({ id: id });
    if (!product) {
      return res.status(404).json({ error: 'Producto no encontrado' });
    }
    
    await cacheSet(cacheKey, JSON.stringify(product), CACHE_TTL);
    res.header('X-Cache', 'MISS');
    res.json(product);
  } catch (error) {
    console.error('Error getting product:', error);
    res.status(500).json({ error: 'Error al obtener producto' });
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
    const { image, images } = processRequestImages(req);
    const body = req.body as any;
    const title = (body.title || '').toString().trim();
    const category = (body.category || '').toString().trim();
    const { price, description, marca, lineaId, iva, ivaPercentage, estado, enOferta, ofertaPorcentaje, ofertaPrecio, rating, colorido, colores } = body;
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

    const lastProduct = await database.getCollection('products')
      .find({})
      .sort({ id: - 1 })
      .limit(1)
      .toArray();

    const newId = lastProduct.length > 0 ? String(Number(lastProduct[0].id) + 1) : '1';

    const newProduct: any = {
      id: newId,
      title,
      price: Number(price),
      description,
      category: category || ' ',
      image: image || ' ',
      rating: rating || { rate: 0, count: 0 },
      marca: marca || null,
      lineaId: lineaId || null,
      iva: iva || false,
      ivaPercentage: ivaPercentage || 16,
      estado: estado || 'disponible',
      enOferta: enOferta || false,
      ofertaPorcentaje: ofertaPorcentaje || 0,
      ofertaPrecio: ofertaPrecio || 0,
      ...(images.length > 0 && { images }),
      colorido: colorido || false,
      colores: colores && colores.length > 0 ? colores : defaultColors,
      createdAt: new Date(),
    };

    await database.getCollection('products').insertOne(newProduct);

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
    const { id } = req.params;
    
    // Process uploaded images
    let { image, images } = processRequestImages(req);
    const body = req.body as any;
    const title = (body.title || '').toString().trim();
    const category = (body.category || '').toString().trim();
    const { price, description, marca, iva, ivaPercentage, estado, lineaId, enOferta, ofertaPorcentaje, ofertaPrecio, colorido, colores, rating } = body;
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
    };

    await database.getCollection('products').updateOne(
      { id },
      { $set: updateData }
    );

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
    const { id } = req.params;
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