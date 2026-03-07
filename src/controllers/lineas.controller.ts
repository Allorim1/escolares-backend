import { Request, Response } from 'express';
import { database } from '../config/database';
import { Linea } from '../models';

export class LineasController {
  async getAll(req: Request, res: Response): Promise<void> {
    try {
      const lineas = await database.getCollection<Linea>('lineas').find({}).toArray();
      res.json(lineas);
    } catch (error) {
      res.status(500).json({ error: 'Error al obtener líneas' });
    }
  }

  async getById(req: Request, res: Response): Promise<void> {
    try {
      const linea = await database.getCollection<Linea>('lineas').findOne({ id: req.params.id });
      if (!linea) {
        res.status(404).json({ error: 'Línea no encontrada' });
        return;
      }
      res.json(linea);
    } catch (error) {
      res.status(500).json({ error: 'Error al obtener línea' });
    }
  }

  async create(req: Request, res: Response): Promise<void> {
    try {
      const userRol = (req as any).userRol;
      if (userRol !== 'owner') {
        res.status(403).json({ error: 'Solo el owner puede crear líneas' });
        return;
      }

      const { name, image } = req.body;
      if (!name) {
        res.status(400).json({ error: 'El nombre es requerido' });
        return;
      }

      const newLinea: Linea = {
        id: Date.now().toString(),
        name,
        image: image || '',
        productIds: [],
      };

      await database.getCollection<Linea>('lineas').insertOne(newLinea);
      res.status(201).json(newLinea);
    } catch (error) {
      res.status(500).json({ error: 'Error al crear línea' });
    }
  }

  async update(req: Request, res: Response): Promise<void> {
    try {
      const userRol = (req as any).userRol;
      if (userRol !== 'owner') {
        res.status(403).json({ error: 'Solo el owner puede modificar líneas' });
        return;
      }

      const { name, image, productIds } = req.body;
      const result = await database
        .getCollection<Linea>('lineas')
        .findOneAndUpdate(
          { id: req.params.id },
          { $set: { name, image, productIds } },
          { returnDocument: 'after' },
        );

      if (!result) {
        res.status(404).json({ error: 'Línea no encontrada' });
        return;
      }
      res.json(result);
    } catch (error) {
      res.status(500).json({ error: 'Error al actualizar línea' });
    }
  }

  async delete(req: Request, res: Response): Promise<void> {
    try {
      const userRol = (req as any).userRol;
      if (userRol !== 'owner') {
        res.status(403).json({ error: 'Solo el owner puede eliminar líneas' });
        return;
      }

      const result = await database.getCollection<Linea>('lineas').deleteOne({ id: req.params.id });
      if (result.deletedCount === 0) {
        res.status(404).json({ error: 'Línea no encontrada' });
        return;
      }
      res.status(204).send();
    } catch (error) {
      res.status(500).json({ error: 'Error al eliminar línea' });
    }
  }

  async addProduct(req: Request, res: Response): Promise<void> {
    try {
      const userRol = (req as any).userRol;
      if (userRol !== 'owner') {
        res.status(403).json({ error: 'Solo el owner puede añadir productos a líneas' });
        return;
      }

      const { productId } = req.body;
      const result = await database
        .getCollection<Linea>('lineas')
        .findOneAndUpdate(
          { id: req.params.id },
          { $addToSet: { productIds: productId } },
          { returnDocument: 'after' },
        );

      if (!result) {
        res.status(404).json({ error: 'Línea no encontrada' });
        return;
      }
      res.json(result);
    } catch (error) {
      res.status(500).json({ error: 'Error al añadir producto' });
    }
  }

  async removeProduct(req: Request, res: Response): Promise<void> {
    try {
      const userRol = (req as any).userRol;
      if (userRol !== 'owner') {
        res.status(403).json({ error: 'Solo el owner puede eliminar productos de líneas' });
        return;
      }

      const { productId } = req.body;
      const result = await database
        .getCollection<Linea>('lineas')
        .findOneAndUpdate(
          { id: req.params.id },
          { $pull: { productIds: productId } },
          { returnDocument: 'after' },
        );

      if (!result) {
        res.status(404).json({ error: 'Línea no encontrada' });
        return;
      }
      res.json(result);
    } catch (error) {
      res.status(500).json({ error: 'Error al eliminar producto' });
    }
  }
}

export const lineasController = new LineasController();
