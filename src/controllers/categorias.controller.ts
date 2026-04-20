import { Request, Response } from 'express';
import { database } from '../config/database';
import { CategoriaMenu, CategoriaItem } from '../models';

export class CategoriasController {
  async getAll(req: Request, res: Response): Promise<void> {
    try {
      const categorias = await database
        .getCollection<CategoriaMenu>('categorias')
        .find({})
        .sort({ orden: 1 })
        .toArray();
      res.json(categorias);
    } catch (error) {
      console.error('Error al obtener categorías:', error);
      res.status(500).json({ error: 'Error al obtener categorías' });
    }
  }

  async create(req: Request, res: Response): Promise<void> {
    try {
      const { nombre, expanded, orden, items } = req.body;

      if (!nombre) {
        res.status(400).json({ error: 'El nombre es requerido' });
        return;
      }

      const id = `categoria-${Date.now()}`;
      const now = new Date();

      const nuevaCategoria: CategoriaMenu = {
        id,
        nombre,
        expanded: expanded ?? true,
        orden: orden ?? 0,
        items: items || [],
        createdAt: now,
        updatedAt: now,
      };

      await database.getCollection<CategoriaMenu>('categorias').insertOne(nuevaCategoria);

      res.status(201).json(nuevaCategoria);
    } catch (error) {
      console.error('Error al crear categoría:', error);
      res.status(500).json({ error: 'Error al crear categoría' });
    }
  }

  async update(req: Request, res: Response): Promise<void> {
    try {
      const { id } = req.params;
      const { nombre, expanded, orden, items } = req.body;

      const updateData: Partial<CategoriaMenu> = {
        updatedAt: new Date(),
      };

      if (nombre !== undefined) updateData.nombre = nombre;
      if (expanded !== undefined) updateData.expanded = expanded;
      if (orden !== undefined) updateData.orden = orden;
      if (items !== undefined) updateData.items = items;

      const result = await database
        .getCollection<CategoriaMenu>('categorias')
        .findOneAndUpdate({ id }, { $set: updateData }, { returnDocument: 'after' });

      if (!result) {
        res.status(404).json({ error: 'Categoría no encontrada' });
        return;
      }

      res.json(result);
    } catch (error) {
      console.error('Error al actualizar categoría:', error);
      res.status(500).json({ error: 'Error al actualizar categoría' });
    }
  }

  async delete(req: Request, res: Response): Promise<void> {
    try {
      const { id } = req.params;

      const result = await database
        .getCollection<CategoriaMenu>('categorias')
        .deleteOne({ id });

      if (result.deletedCount === 0) {
        res.status(404).json({ error: 'Categoría no encontrada' });
        return;
      }

      res.json({ message: 'Categoría eliminada correctamente' });
    } catch (error) {
      console.error('Error al eliminar categoría:', error);
      res.status(500).json({ error: 'Error al eliminar categoría' });
    }
  }

  async addItem(req: Request, res: Response): Promise<void> {
    try {
      const { id } = req.params;
      const { label, route, permiso } = req.body;

      if (!label || !route) {
        res.status(400).json({ error: 'Label y route son requeridos' });
        return;
      }

      const newItem: CategoriaItem = { label, route, permiso };

      const result = await database
        .getCollection<CategoriaMenu>('categorias')
        .findOneAndUpdate(
          { id },
          { $push: { items: newItem }, $set: { updatedAt: new Date() } },
          { returnDocument: 'after' }
        );

      if (!result) {
        res.status(404).json({ error: 'Categoría no encontrada' });
        return;
      }

      res.json(result);
    } catch (error) {
      console.error('Error al añadir item:', error);
      res.status(500).json({ error: 'Error al añadir item' });
    }
  }

  async removeItem(req: Request, res: Response): Promise<void> {
    try {
      const { id, itemIndex } = req.params;
      const index = parseInt(itemIndex);

      if (isNaN(index)) {
        res.status(400).json({ error: 'Índice inválido' });
        return;
      }

      const result = await database
        .getCollection<CategoriaMenu>('categorias')
        .findOneAndUpdate(
          { id },
          { $unset: { [`items.${index}`]: 1 }, $set: { updatedAt: new Date() } },
          { returnDocument: 'after' }
        );

      if (!result) {
        res.status(404).json({ error: 'Categoría no encontrada' });
        return;
      }

      // Clean upnull values
      await database.getCollection<CategoriaMenu>('categorias').updateOne(
        { id },
        { $pull: { items: null } as any }
      );

      res.json(result);
    } catch (error) {
      console.error('Error al eliminar item:', error);
      res.status(500).json({ error: 'Error al eliminar item' });
    }
  }
}

export const categoriasController = new CategoriasController();