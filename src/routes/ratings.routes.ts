import express, { Request, Response } from 'express';
import { database } from '../config/database';
import { authenticateToken } from '../middlewares/auth.middleware';

const router = express.Router();

router.get('/:productId/stats', async (req: Request, res: Response) => {
  try {
    const { productId } = req.params;
    const ratings = await database.getCollection('productRatings').find({ productId }).toArray();
    
    if (ratings.length === 0) {
      return res.json({ averageRate: 0, count: 0 });
    }
    
    const sum = ratings.reduce((acc: number, r: any) => acc + r.rate, 0);
    const average = Number((sum / ratings.length).toFixed(1));
    
    res.json({ 
      averageRate: average, 
      count: ratings.length 
    });
  } catch (error) {
    console.error('Error getting product stats:', error);
    res.status(500).json({ error: 'Error al obtener estadísticas' });
  }
});

router.get('/:productId/user', authenticateToken, async (req: Request, res: Response) => {
  try {
    const { productId } = req.params;
    const userId = req.user?.id || req.user?._id;
    
    if (!userId) {
      return res.status(401).json({ error: 'No autenticado' });
    }
    
    const rating = await database.getCollection('productRatings').findOne({ productId, userId });
    
    res.json({ rate: rating?.rate });
  } catch (error) {
    console.error('Error getting user rating:', error);
    res.status(500).json({ error: 'Error al obtener calificación' });
  }
});

router.post('/', authenticateToken, async (req: Request, res: Response) => {
  try {
    const { productId, rate } = req.body;
    const userId = req.user?.id || req.user?._id;
    
    if (!userId) {
      return res.status(401).json({ error: 'No autenticado' });
    }
    
    if (!rate || rate < 1 || rate > 5) {
      return res.status(400).json({ error: 'La calificación debe estar entre 1 y 5' });
    }
    
    const collection = database.getCollection('productRatings');
    
    await collection.deleteMany({ productId, userId });
    
    await collection.insertOne({
      productId,
      userId,
      rate,
      createdAt: new Date()
    });
    
    const allRatings = await collection.find({ productId }).toArray();
    const sum = allRatings.reduce((acc: number, r: any) => acc + r.rate, 0);
    const average = Number((sum / allRatings.length).toFixed(1));
    
    res.json({ 
      success: true, 
      newAverage: average,
      count: allRatings.length
    });
  } catch (error) {
    console.error('Error submitting rating:', error);
    res.status(500).json({ error: 'Error al guardar calificación' });
  }
});

export default router;