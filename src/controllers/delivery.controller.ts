import { Request, Response } from 'express';
import { database } from '../config/database';
import { DeliveryPerson } from '../models';

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

export class DeliveryController {
  async getAll(req: Request, res: Response): Promise<void> {
    try {
      const deliveryPersons = await database.getCollection<DeliveryPerson>('deliveryPersons').find({}).toArray();
      res.json(deliveryPersons);
    } catch (error) {
      console.error('Error getting delivery persons:', error);
      res.status(500).json({ error: 'Error al obtener repartidores' });
    }
  }

  async getById(req: Request, res: Response): Promise<void> {
    try {
      const deliveryPerson = await database.getCollection<DeliveryPerson>('deliveryPersons').findOne({ id: req.params.id });
      if (!deliveryPerson) {
        res.status(404).json({ error: 'Repartidor no encontrado' });
        return;
      }
      res.json(deliveryPerson);
    } catch (error) {
      res.status(500).json({ error: 'Error al obtener repartidor' });
    }
  }

  async create(req: Request, res: Response): Promise<void> {
    try {
      const usuario = (req as any).user?.nombre || (req as any).user?.username || (req as any).user?.email || 'Sistema';
      const { nombre, telefono, activo } = req.body;
      if (!nombre) {
        res.status(400).json({ error: 'El nombre es requerido' });
        return;
      }

      const newDeliveryPerson: DeliveryPerson = {
        id: Date.now().toString(),
        nombre,
        telefono: telefono || '',
        activo: activo !== undefined ? activo : true,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      await database.getCollection<DeliveryPerson>('deliveryPersons').insertOne(newDeliveryPerson);

      await crearRegistro('Creación', 'Repartidores', `Repartidor creado: ${nombre}`, { repartidor: newDeliveryPerson }, usuario);

      res.status(201).json(newDeliveryPerson);
    } catch (error) {
      console.error('Error creating delivery person:', error);
      res.status(500).json({ error: 'Error al crear repartidor' });
    }
  }

  async update(req: Request, res: Response): Promise<void> {
    try {
      const usuario = (req as any).user?.nombre || (req as any).user?.username || (req as any).user?.email || 'Sistema';
      const { nombre, telefono, activo } = req.body;

      const deliveryPersonAnterior = await database.getCollection<DeliveryPerson>('deliveryPersons').findOne({ id: req.params.id });
      if (!deliveryPersonAnterior) {
        res.status(404).json({ error: 'Repartidor no encontrado' });
        return;
      }

      const updateData: any = {
        updatedAt: new Date(),
      };
      if (nombre !== undefined) updateData.nombre = nombre;
      if (telefono !== undefined) updateData.telefono = telefono;
      if (activo !== undefined) updateData.activo = activo;

      const result = await database
        .getCollection<DeliveryPerson>('deliveryPersons')
        .findOneAndUpdate(
          { id: req.params.id },
          { $set: updateData },
          { returnDocument: 'after' },
        );

      if (!result) {
        res.status(404).json({ error: 'Repartidor no encontrado' });
        return;
      }

      await crearRegistro('Modificación', 'Repartidores', `Repartidor modificado: ${nombre || deliveryPersonAnterior.nombre}`, 
        { repartidorAnterior: deliveryPersonAnterior, repartidorNuevo: result }, usuario);

      res.json(result);
    } catch (error) {
      console.error('Error updating delivery person:', error);
      res.status(500).json({ error: 'Error al actualizar repartidor' });
    }
  }

  async delete(req: Request, res: Response): Promise<void> {
    try {
      const usuario = (req as any).user?.nombre || (req as any).user?.username || (req as any).user?.email || 'Sistema';
      const deliveryPersonEliminado = await database.getCollection<DeliveryPerson>('deliveryPersons').findOne({ id: req.params.id });
      if (!deliveryPersonEliminado) {
        res.status(404).json({ error: 'Repartidor no encontrado' });
        return;
      }

      // Verificar si el repartidor está asignado a algún pedido
      const ordersCollection = database.getCollection('orders');
      const assignedOrders = await ordersCollection.countDocuments({ deliveryPersonId: req.params.id });
      if (assignedOrders > 0) {
        res.status(400).json({ error: 'No se puede eliminar el repartidor porque tiene pedidos asignados' });
        return;
      }

      const result = await database.getCollection<DeliveryPerson>('deliveryPersons').deleteOne({ id: req.params.id });
      if (result.deletedCount === 0) {
        res.status(404).json({ error: 'Repartidor no encontrado' });
        return;
      }

      await crearRegistro('Eliminación', 'Repartidores', `Repartidor eliminado: ${deliveryPersonEliminado.nombre}`, 
        { repartidor: deliveryPersonEliminado }, usuario);

      res.json({ success: true });
    } catch (error) {
      console.error('Error deleting delivery person:', error);
      res.status(500).json({ error: 'Error al eliminar repartidor' });
    }
  }
}

export const deliveryController = new DeliveryController();