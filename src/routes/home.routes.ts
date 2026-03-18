import express, { Request, Response } from 'express';
import { database } from '../config/database';
import { authenticateToken } from '../middlewares/auth.middleware';

const router = express.Router();

interface HomeBanner {
  id: string;
  title: string;
  subtitle: string;
  image: string;
  link: string;
  order: number;
  active: boolean;
}

interface HomeFeature {
  id: string;
  icon: string;
  title: string;
  description: string;
  order: number;
  active: boolean;
}

interface HomeSettings {
  banners: HomeBanner[];
  features: HomeFeature[];
  featuredProducts: string[];
  showNewsletter: boolean;
  showMarcas: boolean;
  showLineas: boolean;
}

router.get('/', async (req: Request, res: Response) => {
  try {
    const home = await database.getCollection('home').findOne({ type: 'settings' });
    if (!home) {
      const defaultSettings: HomeSettings = {
        banners: [],
        features: [
          { id: '1', icon: '🚚', title: 'Envíos a Domicilio', description: 'Entrega en Valencia y toda Venezuela', order: 1, active: true },
          { id: '2', icon: '🏪', title: 'Solo los Mejores Productos', description: 'La mejor calidad del mercado', order: 2, active: true },
          { id: '3', icon: '💳', title: 'Pagos Seguros', description: 'Zelle, efectivo y transferencias', order: 3, active: true },
          { id: '4', icon: '📞', title: 'Atención Personalizada', description: 'Te asesoramos en lo que necesites', order: 4, active: true },
        ],
        featuredProducts: [],
        showNewsletter: true,
        showMarcas: true,
        showLineas: true,
      };
      await database.getCollection('home').insertOne({ type: 'settings', ...defaultSettings });
      return res.json(defaultSettings);
    }
    delete home._id;
    delete home.type;
    res.json(home);
  } catch (error) {
    console.error('Error getting home settings:', error);
    res.status(500).json({ error: 'Error al obtener configuración del inicio' });
  }
});

router.put('/', authenticateToken, async (req: Request, res: Response) => {
  try {
    const { banners, features, featuredProducts, showNewsletter, showMarcas, showLineas } = req.body;
    
    const updateData: any = {
      type: 'settings',
      banners: banners || [],
      features: features || [],
      featuredProducts: featuredProducts || [],
      showNewsletter: showNewsletter !== undefined ? showNewsletter : true,
      showMarcas: showMarcas !== undefined ? showMarcas : true,
      showLineas: showLineas !== undefined ? showLineas : true,
      updatedAt: new Date(),
    };

    await database.getCollection('home').updateOne(
      { type: 'settings' },
      { $set: updateData },
      { upsert: true }
    );

    const updated = await database.getCollection('home').findOne({ type: 'settings' });
    delete updated?._id;
    delete updated?.type;
    res.json(updated);
  } catch (error) {
    console.error('Error updating home settings:', error);
    res.status(500).json({ error: 'Error al actualizar configuración del inicio' });
  }
});

router.post('/banners', authenticateToken, async (req: Request, res: Response) => {
  try {
    const { title, subtitle, image, link, order, active } = req.body;
    
    const home = await database.getCollection('home').findOne({ type: 'settings' });
    const banners = home?.banners || [];
    
    const newBanner: HomeBanner = {
      id: String(Date.now()),
      title: title || '',
      subtitle: subtitle || '',
      image: image || '',
      link: link || '',
      order: order || banners.length + 1,
      active: active !== undefined ? active : true,
    };
    
    banners.push(newBanner);
    
    await database.getCollection('home').updateOne(
      { type: 'settings' },
      { $set: { banners, updatedAt: new Date() }, $setOnInsert: { type: 'settings' } },
      { upsert: true }
    );
    
    res.json(newBanner);
  } catch (error) {
    console.error('Error adding banner:', error);
    res.status(500).json({ error: 'Error al agregar banner' });
  }
});

router.put('/banners/:id', authenticateToken, async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { title, subtitle, image, link, order, active } = req.body;
    
    const home = await database.getCollection('home').findOne({ type: 'settings' });
    const banners: HomeBanner[] = home?.banners || [];
    
    const bannerIndex = banners.findIndex(b => b.id === id);
    if (bannerIndex === -1) {
      return res.status(404).json({ error: 'Banner no encontrado' });
    }
    
    banners[bannerIndex] = {
      ...banners[bannerIndex],
      title: title !== undefined ? title : banners[bannerIndex].title,
      subtitle: subtitle !== undefined ? subtitle : banners[bannerIndex].subtitle,
      image: image !== undefined ? image : banners[bannerIndex].image,
      link: link !== undefined ? link : banners[bannerIndex].link,
      order: order !== undefined ? order : banners[bannerIndex].order,
      active: active !== undefined ? active : banners[bannerIndex].active,
    };
    
    await database.getCollection('home').updateOne(
      { type: 'settings' },
      { $set: { banners, updatedAt: new Date() } }
    );
    
    res.json(banners[bannerIndex]);
  } catch (error) {
    console.error('Error updating banner:', error);
    res.status(500).json({ error: 'Error al actualizar banner' });
  }
});

router.delete('/banners/:id', authenticateToken, async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    
    const home = await database.getCollection('home').findOne({ type: 'settings' });
    const banners: HomeBanner[] = home?.banners || [];
    
    const filteredBanners = banners.filter(b => b.id !== id);
    
    await database.getCollection('home').updateOne(
      { type: 'settings' },
      { $set: { banners: filteredBanners, updatedAt: new Date() } }
    );
    
    res.json({ success: true });
  } catch (error) {
    console.error('Error deleting banner:', error);
    res.status(500).json({ error: 'Error al eliminar banner' });
  }
});

router.post('/features', authenticateToken, async (req: Request, res: Response) => {
  try {
    const { icon, title, description, order, active } = req.body;
    
    const home = await database.getCollection('home').findOne({ type: 'settings' });
    const features = home?.features || [];
    
    const newFeature: HomeFeature = {
      id: String(Date.now()),
      icon: icon || '📦',
      title: title || '',
      description: description || '',
      order: order || features.length + 1,
      active: active !== undefined ? active : true,
    };
    
    features.push(newFeature);
    
    await database.getCollection('home').updateOne(
      { type: 'settings' },
      { $set: { features, updatedAt: new Date() }, $setOnInsert: { type: 'settings' } },
      { upsert: true }
    );
    
    res.json(newFeature);
  } catch (error) {
    console.error('Error adding feature:', error);
    res.status(500).json({ error: 'Error al agregar característica' });
  }
});

router.put('/features/:id', authenticateToken, async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { icon, title, description, order, active } = req.body;
    
    const home = await database.getCollection('home').findOne({ type: 'settings' });
    const features: HomeFeature[] = home?.features || [];
    
    const featureIndex = features.findIndex(f => f.id === id);
    if (featureIndex === -1) {
      return res.status(404).json({ error: 'Característica no encontrada' });
    }
    
    features[featureIndex] = {
      ...features[featureIndex],
      icon: icon !== undefined ? icon : features[featureIndex].icon,
      title: title !== undefined ? title : features[featureIndex].title,
      description: description !== undefined ? description : features[featureIndex].description,
      order: order !== undefined ? order : features[featureIndex].order,
      active: active !== undefined ? active : features[featureIndex].active,
    };
    
    await database.getCollection('home').updateOne(
      { type: 'settings' },
      { $set: { features, updatedAt: new Date() } }
    );
    
    res.json(features[featureIndex]);
  } catch (error) {
    console.error('Error updating feature:', error);
    res.status(500).json({ error: 'Error al actualizar característica' });
  }
});

router.delete('/features/:id', authenticateToken, async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    
    const home = await database.getCollection('home').findOne({ type: 'settings' });
    const features: HomeFeature[] = home?.features || [];
    
    const filteredFeatures = features.filter(f => f.id !== id);
    
    await database.getCollection('home').updateOne(
      { type: 'settings' },
      { $set: { features: filteredFeatures, updatedAt: new Date() } }
    );
    
    res.json({ success: true });
  } catch (error) {
    console.error('Error deleting feature:', error);
    res.status(500).json({ error: 'Error al eliminar característica' });
  }
});

export default router;
