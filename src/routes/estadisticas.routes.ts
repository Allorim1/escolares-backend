import { Router, Request, Response } from 'express';
import { database } from '../config/database';
import { authenticateToken } from '../middlewares/auth.middleware';

const router = Router();

const isAdmin = async (req: Request) => {
  const userId = req.user?.userId;
  if (!userId) return false;
  const user = await database.getCollection<any>('users').findOne({ id: userId });
  return !!user && (user.rol === 'root' || user.rol === 'admin' || user.isAdmin === true);
};

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

    const pendingOrders = allOrders.filter((o: any) => o.status === 'pendiente' || o.status === 'confirmar').length;
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

router.get('/dashboard', authenticateToken, async (req: Request, res: Response) => {
  try {
    if (!(await isAdmin(req))) {
      res.status(403).json({ error: 'Acceso denegado' });
      return;
    }

    const productsCol = database.getCollection<any>('products');
    const ordersCol = database.getCollection<any>('orders');
    const usersCol = database.getCollection<any>('users');

    const [products, orders, usersCount] = await Promise.all([
      productsCol.find({}).toArray(),
      ordersCol.find({}).sort({ createdAt: -1 }).limit(200).toArray(),
      usersCol.countDocuments({}),
    ]);

    const now = new Date();
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const last7 = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

    const totalProducts = products.length;
    const outOfStock = products.filter((p: any) => p.estado === 'agotado' || (typeof p.unidades === 'number' && p.unidades <= 0)).length;
    const lowStock = products.filter((p: any) => {
      if (p.estado === 'agotado') return false;
      const u = typeof p.unidades === 'number' ? p.unidades : null;
      return u !== null && u > 0 && u <= 5;
    }).length;

    const totalOrders = orders.length;
    const pendingOrders = orders.filter((o: any) => ['confirmar', 'pendiente'].includes(o.status)).length;
    const processingOrders = orders.filter((o: any) => ['procesando', 'procesado', 'enviado'].includes(o.status)).length;
    const deliveredOrders = orders.filter((o: any) => o.status === 'entregado').length;
    const incidentOrders = orders.filter((o: any) => o.status === 'incidencia').length;
    const unassignedOrders = orders.filter((o: any) => !o.deliveryPersonId && !['entregado', 'cancelado', 'incidencia'].includes(o.status)).length;
    const deliveredToday = orders.filter((o: any) => o.status === 'entregado' && o.updatedAt && new Date(o.updatedAt) >= startOfToday).length;
    const ordersLast7Days = orders.filter((o: any) => o.createdAt && new Date(o.createdAt) >= last7).length;

    const totalViews = products.reduce((sum: number, p: any) => sum + (p.views || 0), 0);
    const totalPurchases = products.reduce((sum: number, p: any) => sum + (p.purchases || 0), 0);
    const conversionRate = totalViews > 0 ? +((totalPurchases / totalViews) * 100).toFixed(2) : 0;

    const recentOrders = orders.slice(0, 8).map((o: any) => ({
      id: o.id,
      nombre: o.nombre || 'Cliente',
      total: o.total || 0,
      status: o.status,
      createdAt: o.createdAt,
      updatedAt: o.updatedAt,
      deliveryPersonName: o.deliveryPersonName || '',
      itemsCount: Array.isArray(o.items) ? o.items.length : 0,
    }));

    const topByPurchases = [...products]
      .sort((a: any, b: any) => (b.purchases || 0) - (a.purchases || 0))
      .slice(0, 5)
      .map((p: any) => ({ id: p.id, title: p.title, image: p.image, price: p.price, views: p.views || 0, purchases: p.purchases || 0, estado: p.estado, unidades: p.unidades }));

    const attention = [] as any[];
    if (incidentOrders > 0) attention.push({ type: 'incidencia', severity: 'high', label: 'Pedidos con incidencia', count: incidentOrders, route: '/admin/pedidos', description: 'Revisar incidencias reportadas por repartidores.' });
    if (pendingOrders > 0) attention.push({ type: 'pendientes', severity: 'medium', label: 'Pedidos pendientes', count: pendingOrders, route: '/admin/pedidos', description: 'Pedidos esperando confirmación o procesamiento.' });
    if (unassignedOrders > 0) attention.push({ type: 'sin_asignar', severity: 'medium', label: 'Pedidos sin repartidor', count: unassignedOrders, route: '/admin/pedidos', description: 'Asignar repartidor para continuar el flujo.' });
    if (outOfStock > 0) attention.push({ type: 'agotados', severity: 'medium', label: 'Productos agotados', count: outOfStock, route: '/admin/productos', description: 'Productos sin disponibilidad visible.' });
    if (lowStock > 0) attention.push({ type: 'stock_bajo', severity: 'low', label: 'Productos con stock bajo', count: lowStock, route: '/admin/productos', description: 'Productos con 5 unidades o menos.' });

    res.json({
      generatedAt: now.toISOString(),
      kpis: {
        totalProducts,
        totalUsers: usersCount,
        totalOrders,
        pendingOrders,
        processingOrders,
        deliveredOrders,
        incidentOrders,
        unassignedOrders,
        deliveredToday,
        ordersLast7Days,
        outOfStock,
        lowStock,
        totalViews,
        totalPurchases,
        conversionRate,
      },
      attention,
      recentOrders,
      topByPurchases,
    });
  } catch (error) {
    console.error('Error getting dashboard:', error);
    res.status(500).json({ error: 'Error al obtener dashboard' });
  }
});

export default router;
