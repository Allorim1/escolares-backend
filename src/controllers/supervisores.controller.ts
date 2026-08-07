import { Request, Response } from 'express';
import { database } from '../config/database';
import { Supervisor } from '../models';

export class SupervisoresController {
  async getAll(req: Request, res: Response): Promise<void> {
    try {
      const supervisores = await database
        .getCollection<Supervisor>('supervisores')
        .find({})
        .sort({ nombre: 1 })
        .toArray();
      res.json(supervisores);
    } catch (error) {
      console.error('Error al obtener supervisores:', error);
      res.status(500).json({ error: 'Error al obtener supervisores' });
    }
  }

  async create(req: Request, res: Response): Promise<void> {
    try {
      const { nombre, cedula, telefono } = req.body;

      if (!nombre || !nombre.trim()) {
        res.status(400).json({ error: 'El nombre es requerido' });
        return;
      }

      const id = `supervisor-${Date.now()}`;
      const now = new Date();

      const supervisor: Supervisor = {
        id,
        nombre: nombre.trim(),
        cedula: cedula?.trim() || '',
        telefono: telefono?.trim() || '',
        createdAt: now,
        updatedAt: now,
      };

      await database.getCollection<Supervisor>('supervisores').insertOne(supervisor);

      res.status(201).json(supervisor);
    } catch (error) {
      console.error('Error al crear supervisor:', error);
      res.status(500).json({ error: 'Error al crear supervisor' });
    }
  }

  async update(req: Request, res: Response): Promise<void> {
    try {
      const idParam = req.params.id;
      const id = Array.isArray(idParam) ? idParam[0] : idParam;
      const { nombre, cedula, telefono } = req.body;

      const updateData: Partial<Supervisor> = {
        updatedAt: new Date(),
      };

      if (nombre !== undefined) updateData.nombre = nombre;
      if (cedula !== undefined) updateData.cedula = cedula;
      if (telefono !== undefined) updateData.telefono = telefono;

      const result = await database
        .getCollection<Supervisor>('supervisores')
        .findOneAndUpdate({ id }, { $set: updateData }, { returnDocument: 'after' });

      if (!result) {
        res.status(404).json({ error: 'Supervisor no encontrado' });
        return;
      }

      res.json(result);
    } catch (error) {
      console.error('Error al actualizar supervisor:', error);
      res.status(500).json({ error: 'Error al actualizar supervisor' });
    }
  }

  async delete(req: Request, res: Response): Promise<void> {
    try {
      const idParam = req.params.id;
      const id = Array.isArray(idParam) ? idParam[0] : idParam;

      const result = await database
        .getCollection<Supervisor>('supervisores')
        .deleteOne({ id });

      if (result.deletedCount === 0) {
        res.status(404).json({ error: 'Supervisor no encontrado' });
        return;
      }

      res.json({ message: 'Supervisor eliminado correctamente' });
    } catch (error) {
      console.error('Error al eliminar supervisor:', error);
      res.status(500).json({ error: 'Error al eliminar supervisor' });
    }
  }
}

export const supervisoresController = new SupervisoresController();
