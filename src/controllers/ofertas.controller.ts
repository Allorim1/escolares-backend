import { Request, Response } from 'express';
import { database } from '../config/database';
import { Oferta } from '../models';

export class OfertasController {
  async getAll(req: Request, res: Response): Promise<void> {
    try {
      const ofertas = await database.getCollection<Oferta>('ofertas').find({}).toArray();
      res.json(ofertas);
    } catch (error) {
      res.status(500).json({ error: 'Error al obtener ofertas' });
    }
  }

  async getByProductId(req: Request, res: Response): Promise<void> {
    try {
      const productId = parseInt(req.params.productId as string);
      const oferta = await database.getCollection<Oferta>('ofertas').findOne({ productId });
      res.json(oferta);
    } catch (error) {
      res.status(500).json({ error: 'Error al obtener oferta' });
    }
  }

  async create(req: Request, res: Response): Promise<void> {
    try {
      const { productId, precioOferta } = req.body;
      if (!productId || !precioOferta) {
        res.status(400).json({ error: 'productId y precioOferta son requeridos' });
        return;
      }

      const existingOferta = await database.getCollection<Oferta>('ofertas').findOne({ productId });
      if (existingOferta) {
        const result = await database
          .getCollection<Oferta>('ofertas')
          .findOneAndUpdate({ productId }, { $set: { precioOferta } }, { returnDocument: 'after' });
        res.json(result);
        return;
      }

      const newOferta: Oferta = { productId, precioOferta };
      await database.getCollection<Oferta>('ofertas').insertOne(newOferta);
      res.status(201).json(newOferta);
    } catch (error) {
      res.status(500).json({ error: 'Error al crear oferta' });
    }
  }

  async delete(req: Request, res: Response): Promise<void> {
    try {
      const productId = parseInt(req.params.productId as string);
      const result = await database.getCollection<Oferta>('ofertas').deleteOne({ productId });
      if (result.deletedCount === 0) {
        res.status(404).json({ error: 'Oferta no encontrada' });
        return;
      }
      res.status(204).send();
    } catch (error) {
      res.status(500).json({ error: 'Error al eliminar oferta' });
    }
  }
}

export const ofertasController = new OfertasController();
