import { Request, Response } from 'express';
import { database } from '../config/database';
import { ProductCategoria } from '../models';

export class ProductCategoriasController {
  async getAll(req: Request, res: Response): Promise<void> {
    try {
      const categorias = await database
        .getCollection<ProductCategoria>('producto-categorias')
        .find({})
        .sort({ orden: 1 })
        .toArray();
      res.json(categorias);
    } catch (error) {
      console.error('Error al obtener categorías de productos:', error);
      res.status(500).json({ error: 'Error al obtener categorías' });
    }
  }

  async create(req: Request, res: Response): Promise<void> {
    try {
      const { nombre, descripcion, imagen, orden } = req.body;

      if (!nombre) {
        res.status(400).json({ error: 'El nombre es requerido' });
        return;
      }

      const id = `cat-prod-${Date.now()}`;
      const now = new Date();

      const nuevaCategoria: ProductCategoria = {
        id,
        nombre,
        descripcion: descripcion || '',
        imagen: imagen || '',
        orden: orden ?? 0,
        createdAt: now,
        updatedAt: now,
      };

      await database.getCollection<ProductCategoria>('producto-categorias').insertOne(nuevaCategoria);

      res.status(201).json(nuevaCategoria);
    } catch (error) {
      console.error('Error al crear categoría de producto:', error);
      res.status(500).json({ error: 'Error al crear categoría' });
    }
  }

  async update(req: Request, res: Response): Promise<void> {
    try {
      const idParam = req.params.id;
      const id = Array.isArray(idParam) ? idParam[0] : idParam;
      const { nombre, descripcion, imagen, orden } = req.body;

      // Obtener la categoría actual para saber el nombre anterior
      const categoriaActual = await database
        .getCollection<ProductCategoria>('producto-categorias')
        .findOne({ id });

      if (!categoriaActual) {
        res.status(404).json({ error: 'Categoría no encontrada' });
        return;
      }

      const updateData: Partial<ProductCategoria> = {
        updatedAt: new Date(),
      };

      if (nombre !== undefined) updateData.nombre = nombre;
      if (descripcion !== undefined) updateData.descripcion = descripcion;
      if (imagen !== undefined) updateData.imagen = imagen;
      if (orden !== undefined) updateData.orden = orden;

      const result = await database
        .getCollection<ProductCategoria>('producto-categorias')
        .findOneAndUpdate({ id }, { $set: updateData }, { returnDocument: 'after' });

      if (!result) {
        res.status(404).json({ error: 'Categoría no encontrada' });
        return;
      }

      // Si se cambió el nombre, actualizar los productos que referencian esta categoría por nombre
      if (nombre !== undefined && nombre !== categoriaActual.nombre) {
        await database
          .getCollection('products')
          .updateMany(
            { category: categoriaActual.nombre },
            { $set: { category: nombre } }
          );
      }

      res.json(result);
    } catch (error) {
      console.error('Error al actualizar categoría de producto:', error);
      res.status(500).json({ error: 'Error al actualizar categoría' });
    }
  }

  async delete(req: Request, res: Response): Promise<void> {
    try {
      const idParam = req.params.id;
      const id = Array.isArray(idParam) ? idParam[0] : idParam;

      // Obtener la categoría antes de eliminarla para saber su nombre
      const categoria = await database
        .getCollection<ProductCategoria>('producto-categorias')
        .findOne({ id });

      if (!categoria) {
        res.status(404).json({ error: 'Categoría no encontrada' });
        return;
      }

      const result = await database
        .getCollection<ProductCategoria>('producto-categorias')
        .deleteOne({ id });

      if (result.deletedCount === 0) {
        res.status(404).json({ error: 'Categoría no encontrada' });
        return;
      }

      // Actualizar productos que tengan esta categoría por nombre
      // Los productos guardan el nombre de la categoría en el campo 'category'
      await database
        .getCollection('products')
        .updateMany(
          { category: categoria.nombre },
          { $set: { category: '' } }
        );

      res.json({ message: 'Categoría eliminada correctamente' });
    } catch (error) {
      console.error('Error al eliminar categoría de producto:', error);
      res.status(500).json({ error: 'Error al eliminar categoría' });
    }
  }
}

export const productCategoriasController = new ProductCategoriasController();
