import express, { Request, Response } from 'express';
import { database } from '../config/database';
import { authenticateToken } from '../middlewares/auth.middleware';

const router = express.Router();

// Default colors for easier selection
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

router.get('/', async (req: Request, res: Response) => {
  try {
    const page = parseInt(req.query.page as string) || 1;
    const limit = parseInt(req.query.limit as string) || 20;
    const skip = (page - 1) * limit;

    const [products, total] = await Promise.all([
      database.getCollection('products').find({}).skip(skip).limit(limit).toArray(),
      database.getCollection('products').countDocuments()
    ]);

    res.json({
      products,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit)
      }
    });
  } catch (error) {
    console.error('Error getting products:', error);
    res.status(500).json({ error: 'Error al obtener productos' });
  }
});

router.get('/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const product = await database.getCollection('products').findOne({ id: id });
    if (!product) {
      return res.status(404).json({ error: 'Producto no encontrado' });
    }
    res.json(product);
  } catch (error) {
    console.error('Error getting product:', error);
    res.status(500).json({ error: 'Error al obtener producto' });
  }
});

router.post('/', authenticateToken, async (req: Request, res: Response) => {
  try {
    const { title, price, description, category, image, marca, lineaId, iva, ivaPercentage, estado, images, enOferta, ofertaPorcentaje, ofertaPrecio, colorido, colores } = req.body;
    const usuario = req.user?.nombre || req.user?.username || req.user?.email || 'Sistema';
    
    const lastProduct = await database.getCollection('products')
      .find({})
      .sort({ id: -1 })
      .limit(1)
      .toArray();
    
    const newId = lastProduct.length > 0 ? String(Number(lastProduct[0].id) + 1) : '1';
    
     const newProduct = {
       id: newId,
       title,
       price: Number(price),
       description,
       category: category || ' ',
       image: image || ' ',
       rating: { rate: 0, count: 0 },
       marca: marca || null,
       lineaId: lineaId || null,
       iva: iva || false,
       ivaPercentage: ivaPercentage || 16,
       estado: estado || 'disponible',
       enOferta: enOferta || false,
       ofertaPorcentaje: ofertaPorcentaje || 0,
       ofertaPrecio: ofertaPrecio || 0,
       ...(images && { images }),
       colorido: colorido || false,
       colores: colores && colores.length > 0 ? colores : defaultColors,
       // stock removido según solicitud
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
    
    res.status(201).json(newProduct);
  } catch (error) {
    console.error('Error creating product:', error);
    res.status(500).json({ error: 'Error al crear producto' });
  }
});

router.put('/:id', authenticateToken, async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { title, price, description, category, image, marca, iva, ivaPercentage, estado, images, lineaId, enOferta, ofertaPorcentaje, ofertaPrecio, colorido, colores } = req.body;
    const usuario = req.user?.nombre || req.user?.username || req.user?.email || 'Sistema';
    
    const productoAnterior = await database.getCollection('products').findOne({ id });
    
     const updateData: any = {
       title,
       price: Number(price),
       description,
       category,
       image,
       marca: marca || null,
       iva: iva || false,
       ivaPercentage: ivaPercentage || 16,
       estado: estado || 'disponible',
       enOferta: enOferta || false,
       ofertaPorcentaje: ofertaPorcentaje || 0,
       ofertaPrecio: ofertaPrecio || 0,
       ...(images && { images }),
       ...(lineaId !== undefined && { lineaId }),
       colorido: colorido || false,
       colores: colores && colores.length > 0 ? colores : defaultColors,
       // stock removido según solicitud
     };
    
    await database.getCollection('products').updateOne(
      { id },
      { $set: updateData }
    );
    
    const updated = await database.getCollection('products').findOne({ id });
    
    await crearRegistro(database, 'Modificación', 'Productos', `Producto modificado: ${title}`, { productoAnterior, productoNuevo: updated }, usuario);
    
    res.json(updated);
  } catch (error) {
    console.error('Error updating product:', error);
    res.status(500).json({ error: 'Error al actualizar producto' });
  }
});

router.delete('/:id', authenticateToken, async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const usuario = req.user?.nombre || req.user?.username || req.user?.email || 'Sistema';
    
    const productoEliminado = await database.getCollection('products').findOne({ id });
    
    await database.getCollection('products').deleteOne({ id });
    
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
