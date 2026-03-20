import express, { Request, Response } from 'express';
import { database } from '../config/database';
import { authenticateToken } from '../middlewares/auth.middleware';

const router = express.Router();

const crearRegistro = async (database: any, accion: string, modulo: string, descripcion: string, datos: any, usuario: string) => {
  let registrosCollection = database.getCollection('registros');
  if (!registrosCollection) {
    await database.db.createCollection('registros');
    registrosCollection = database.getCollection('registros');
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
    const products = await database.getCollection('products').find({}).toArray();
    res.json(products);
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
    const { title, price, description, category, image, marca } = req.body;
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
      category: category || 'electronics',
      image: image || 'https://fakestoreapi.com/img/81fPKd-2AYL._AC_SL1500_.jpg',
      rating: { rate: 0, count: 0 },
      marca: marca || null,
      createdAt: new Date(),
    };
    
    await database.getCollection('products').insertOne(newProduct);
    
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
    const { title, price, description, category, image, marca } = req.body;
    const usuario = req.user?.nombre || req.user?.username || req.user?.email || 'Sistema';
    
    const productoAnterior = await database.getCollection('products').findOne({ id });
    
    const updateData: any = {
      title,
      price: Number(price),
      description,
      category,
      image,
      marca: marca || null,
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
