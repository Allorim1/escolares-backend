import { Request, Response } from 'express';
import { database } from '../config/database';

interface Noticia {
  id: string;
  titulo: string;
  contenido: string;
  fecha: Date;
  activa: boolean;
  importante: boolean;
}

const crearRegistro = async (accion: string, modulo: string, descripcion: string, datos: any, usuario: string) => {
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

export class NoticiasController {
  async getAll(req: Request, res: Response): Promise<void> {
    try {
      const noticias = await database
        .getCollection<Noticia>('noticias')
        .find({ activa: true })
        .sort({ fecha: -1 })
        .toArray();
      res.json(noticias);
    } catch (error) {
      console.error('Error al obtener noticias:', error);
      res.status(500).json({ error: 'Error al obtener noticias' });
    }
  }

  async getAllAdmin(req: Request, res: Response): Promise<void> {
    try {
      const noticias = await database
        .getCollection<Noticia>('noticias')
        .find({})
        .sort({ fecha: -1 })
        .toArray();
      res.json(noticias);
    } catch (error) {
      console.error('Error al obtener noticias:', error);
      res.status(500).json({ error: 'Error al obtener noticias' });
    }
  }

  async getById(req: Request, res: Response): Promise<void> {
    try {
      const idParam = req.params.id;
      const id = Array.isArray(idParam) ? idParam[0] : idParam;
      const noticia = await database.getCollection<Noticia>('noticias').findOne({ id });
      if (!noticia) {
        res.status(404).json({ error: 'Noticia no encontrada' });
        return;
      }
      res.json(noticia);
    } catch (error) {
      console.error('Error al obtener noticia:', error);
      res.status(500).json({ error: 'Error al obtener noticia' });
    }
  }

  async create(req: Request, res: Response): Promise<void> {
    try {
      const usuario = (req as any).user?.nombre || (req as any).user?.username || (req as any).user?.email || 'Sistema';
      const { titulo, contenido, importante } = req.body;

      if (!titulo || !contenido) {
        res.status(400).json({ error: 'Título y contenido son requeridos' });
        return;
      }

      const id = `noticia-${Date.now()}`;
      const now = new Date();

      const nuevaNoticia: Noticia = {
        id,
        titulo,
        contenido,
        fecha: now,
        activa: true,
        importante: importante || false,
      };

      await database.getCollection<Noticia>('noticias').insertOne(nuevaNoticia);

      await crearRegistro('Creación', 'Noticias', `Noticia creada: ${titulo}`, { noticia: nuevaNoticia }, usuario);

      res.status(201).json(nuevaNoticia);
    } catch (error) {
      console.error('Error al crear noticia:', error);
      res.status(500).json({ error: 'Error al crear noticia' });
    }
  }

  async update(req: Request, res: Response): Promise<void> {
    try {
      const usuario = (req as any).user?.nombre || (req as any).user?.username || (req as any).user?.email || 'Sistema';
      const idParam = req.params.id;
      const id = Array.isArray(idParam) ? idParam[0] : idParam;
      const { titulo, contenido, activa, importante } = req.body;

      const noticiaAnterior = await database.getCollection<Noticia>('noticias').findOne({ id });

      const updateData: Partial<Noticia> = {
        updatedAt: new Date(),
      };

      if (titulo !== undefined) updateData.titulo = titulo;
      if (contenido !== undefined) updateData.contenido = contenido;
      if (activa !== undefined) updateData.activa = activa;
      if (importante !== undefined) updateData.importante = importante;

      const result = await database
        .getCollection<Noticia>('noticias')
        .findOneAndUpdate({ id }, { $set: updateData }, { returnDocument: 'after' });

      if (!result) {
        res.status(404).json({ error: 'Noticia no encontrada' });
        return;
      }

      await crearRegistro('Modificación', 'Noticias', `Noticia modificada: ${titulo || noticiaAnterior?.titulo}`, { noticiaAnterior, noticiaNueva: result }, usuario);

      res.json(result);
    } catch (error) {
      console.error('Error al actualizar noticia:', error);
      res.status(500).json({ error: 'Error al actualizar noticia' });
    }
  }

  async delete(req: Request, res: Response): Promise<void> {
    try {
      const usuario = (req as any).user?.nombre || (req as any).user?.username || (req as any).user?.email || 'Sistema';
      const idParam = req.params.id;
      const id = Array.isArray(idParam) ? idParam[0] : idParam;

      const noticiaEliminada = await database.getCollection<Noticia>('noticias').findOne({ id });
      const result = await database.getCollection<Noticia>('noticias').deleteOne({ id });

      if (result.deletedCount === 0) {
        res.status(404).json({ error: 'Noticia no encontrada' });
        return;
      }

      if (noticiaEliminada) {
        await crearRegistro('Eliminación', 'Noticias', `Noticia eliminada: ${noticiaEliminada.titulo}`, { noticia: noticiaEliminada }, usuario);
      }

      res.json({ message: 'Noticia eliminada correctamente' });
    } catch (error) {
      console.error('Error al eliminar noticia:', error);
      res.status(500).json({ error: 'Error al eliminar noticia' });
    }
  }
}

export const noticiasController = new NoticiasController();