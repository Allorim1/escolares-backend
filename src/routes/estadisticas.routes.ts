import { Router, Request, Response } from 'express';
import { database } from '../config/database';
import { authenticateToken } from '../middlewares/auth.middleware';

const router = Router();

router.get('/productos/top', authenticateToken, async (_req: Request, res: Response) => {
  try {
    const products = await database.getCollection('products')
      .find({})
      .sort({ views: -1 })
      .limit(20)
      .toArray();

    res.json(products.map((p: any) => ({
      id: p.id,
      title: p.title,
      image: p.image,
      price: p.price,
      views: p.views || 0,
      purchases: p.purchases || 0,
    })));
  } catch (error) {
    console.error('Error getting top products stats:', error);
    res.status(500).json({ error: 'Error al obtener estadísticas de productos' });
  }
});

router.get('/resumen', authenticateToken, async (_req: Request, res: Response) => {
  try {
    const productsCollection = database.getCollection('products');
    const ordersCollection = database.getCollection('orders');

    const [allProducts, allOrders, topProducts] = await Promise.all([
      productsCollection.find({}).toArray(),
      ordersCollection.find({}).toArray(),
      productsCollection.find({}).sort({ purchases: -1 }).limit(10).toArray(),
    ]);

    const totalViews = allProducts.reduce((sum: number, p: any) => sum + (p.views || 0), 0);
    const totalPurchases = allProducts.reduce((sum: number, p: any) => sum + (p.purchases || 0), 0);
    const conversionRate = totalViews > 0 ? ((totalPurchases / totalViews) * 100).toFixed(2) : '0.00';

    const topByViews = [...allProducts]
      .sort((a: any, b: any) => (b.views || 0) - (a.views || 0))
      .slice(0, 10)
      .map((p: any) => ({
        id: p.id,
        title: p.title,
        image: p.image,
        price: p.price,
        views: p.views || 0,
        purchases: p.purchases || 0,
      }));

    const topByPurchases = [...allProducts]
      .sort((a: any, b: any) => (b.purchases || 0) - (a.purchases || 0))
      .slice(0, 10)
      .map((p: any) => ({
        id: p.id,
        title: p.title,
        image: p.image,
        price: p.price,
        views: p.views || 0,
        purchases: p.purchases || 0,
      }));

    const pendingOrders = allOrders.filter((o: any) => o.status === 'pendiente').length;
    const deliveredOrders = allOrders.filter((o: any) => o.status === 'entregado').length;

    res.json({
      totalProducts: allProducts.length,
      totalOrders: allOrders.length,
      pendingOrders,
      deliveredOrders,
      totalViews,
      totalPurchases,
      conversionRate,
      topByViews,
      topByPurchases,
    });
  } catch (error) {
    console.error('Error getting stats resumen:', error);
    res.status(500).json({ error: 'Error al obtener resumen de estadísticas' });
  }
});

export default router;
