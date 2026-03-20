import { Request, Response } from 'express';
import { database } from '../config/database';
import { Oferta } from '../models';

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
      const usuario = (req as any).user?.nombre || (req as any).user?.username || (req as any).user?.email || 'Sistema';
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

        await crearRegistro('Modificación', 'Ofertas', `Oferta modificada para producto ${productId}`, { ofertaAnterior: existingOferta, ofertaNueva: result }, usuario);

        res.json(result);
        return;
      }

      const newOferta: Oferta = { productId, precioOferta };
      await database.getCollection<Oferta>('ofertas').insertOne(newOferta);

      await crearRegistro('Creación', 'Ofertas', `Oferta creada para producto ${productId}`, { oferta: newOferta }, usuario);

      res.status(201).json(newOferta);
    } catch (error) {
      res.status(500).json({ error: 'Error al crear oferta' });
    }
  }

  async delete(req: Request, res: Response): Promise<void> {
    try {
      const usuario = (req as any).user?.nombre || (req as any).user?.username || (req as any).user?.email || 'Sistema';
      const productId = parseInt(req.params.productId as string);
      const ofertaEliminada = await database.getCollection<Oferta>('ofertas').findOne({ productId });
      const result = await database.getCollection<Oferta>('ofertas').deleteOne({ productId });
      if (result.deletedCount === 0) {
        res.status(404).json({ error: 'Oferta no encontrada' });
        return;
      }

      if (ofertaEliminada) {
        await crearRegistro('Eliminación', 'Ofertas', `Oferta eliminada para producto ${productId}`, { oferta: ofertaEliminada }, usuario);
      }

      res.json({ success: true });
    } catch (error) {
      res.status(500).json({ error: 'Error al eliminar oferta' });
    }
  }
}

export const ofertasController = new OfertasController();
