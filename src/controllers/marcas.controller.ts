import { Request, Response } from 'express';
import { database } from '../config/database';
import { Marca } from '../models';

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

export class MarcasController {
  async getAll(req: Request, res: Response): Promise<void> {
    try {
      const marcas = await database.getCollection<Marca>('marcas').find({}).toArray();
      res.json(marcas);
    } catch (error) {
      console.error('Error getting marcas:', error);
      res.status(500).json({ error: 'Error al obtener marcas' });
    }
  }

  async getById(req: Request, res: Response): Promise<void> {
    try {
      const marca = await database.getCollection<Marca>('marcas').findOne({ id: req.params.id });
      if (!marca) {
        res.status(404).json({ error: 'Marca no encontrada' });
        return;
      }
      res.json(marca);
    } catch (error) {
      res.status(500).json({ error: 'Error al obtener marca' });
    }
  }

  async create(req: Request, res: Response): Promise<void> {
    try {
      const userRol = (req as any).userRol;
      const usuario = (req as any).user?.nombre || (req as any).user?.username || (req as any).user?.email || 'Sistema';
      if (userRol !== 'owner') {
        res.status(403).json({ error: 'Solo el owner puede crear marcas' });
        return;
      }

      const { name, image } = req.body;
      if (!name) {
        res.status(400).json({ error: 'El nombre es requerido' });
        return;
      }

      const newMarca: Marca = {
        id: Date.now().toString(),
        name,
        image: image || '',
      };

      await database.getCollection<Marca>('marcas').insertOne(newMarca);

      await crearRegistro('Creación', 'Marcas', `Marca creada: ${name}`, { marca: newMarca }, usuario);

      res.status(201).json(newMarca);
    } catch (error) {
      res.status(500).json({ error: 'Error al crear marca' });
    }
  }

  async update(req: Request, res: Response): Promise<void> {
    try {
      const userRol = (req as any).userRol;
      const usuario = (req as any).user?.nombre || (req as any).user?.username || (req as any).user?.email || 'Sistema';
      if (userRol !== 'owner') {
        res.status(403).json({ error: 'Solo el owner puede modificar marcas' });
        return;
      }

      const marcaAnterior = await database.getCollection<Marca>('marcas').findOne({ id: req.params.id });
      const { name, image } = req.body;
      const result = await database
        .getCollection<Marca>('marcas')
        .findOneAndUpdate(
          { id: req.params.id },
          { $set: { name, image } },
          { returnDocument: 'after' },
        );

      if (!result) {
        res.status(404).json({ error: 'Marca no encontrada' });
        return;
      }

      await crearRegistro('Modificación', 'Marcas', `Marca modificada: ${name}`, { marcaAnterior, marcaNueva: result }, usuario);

      res.json(result);
    } catch (error) {
      res.status(500).json({ error: 'Error al actualizar marca' });
    }
  }

  async delete(req: Request, res: Response): Promise<void> {
    try {
      const userRol = (req as any).userRol;
      const usuario = (req as any).user?.nombre || (req as any).user?.username || (req as any).user?.email || 'Sistema';
      if (userRol !== 'owner') {
        res.status(403).json({ error: 'Solo el owner puede eliminar marcas' });
        return;
      }

      const marcaEliminada = await database.getCollection<Marca>('marcas').findOne({ id: req.params.id });
      const result = await database.getCollection<Marca>('marcas').deleteOne({ id: req.params.id });
      if (result.deletedCount === 0) {
        res.status(404).json({ error: 'Marca no encontrada' });
        return;
      }

      if (marcaEliminada) {
        await crearRegistro('Eliminación', 'Marcas', `Marca eliminada: ${marcaEliminada.name}`, { marca: marcaEliminada }, usuario);
      }

      res.json({ success: true });
    } catch (error) {
      res.status(500).json({ error: 'Error al eliminar marca' });
    }
  }
}

export const marcasController = new MarcasController();
