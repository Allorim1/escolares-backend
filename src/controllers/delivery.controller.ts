import { Request, Response } from 'express';
import { database } from '../config/database';
import { DeliveryPerson, Order } from '../models';
import { googleMapsService } from '../services/google-maps.service';
import argon2 from 'argon2';

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

  async getByUserId(req: Request, res: Response): Promise<void> {
    try {
      const deliveryPerson = await database.getCollection<DeliveryPerson>('deliveryPersons').findOne({ userId: req.params.userId });
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
      const { nombre, telefono, activo, email, password, fotoDNI } = req.body;
      if (!nombre) {
        res.status(400).json({ error: 'El nombre es requerido' });
        return;
      }
      if (!email || !password) {
        res.status(400).json({ error: 'Email y password son requeridos para crear el repartidor' });
        return;
      }

      const newDeliveryPerson: DeliveryPerson = {
        id: Date.now().toString(),
        nombre,
        telefono: telefono || '',
        activo: activo !== undefined ? activo : true,
        createdAt: new Date(),
        updatedAt: new Date(),
        ...(fotoDNI && { fotoDNI }),
      };

      await database.getCollection<DeliveryPerson>('deliveryPersons').insertOne(newDeliveryPerson);

      await crearRegistro('Creación', 'Repartidores', `Repartidor creado: ${nombre}`, { repartidor: newDeliveryPerson }, usuario);

      const existingUser = await database.getCollection('users').findOne({ $or: [{ username: email }, { email }] });
      if (existingUser) {
        res.status(400).json({ error: 'Email ya existe' });
        return;
      }

      const repartidorRol = await database.getCollection('roles').findOne({ nombre: 'repartidor' });
      const rolId = repartidorRol?.id || '';

      const newUser = {
        id: Date.now().toString() + '-user',
        username: email,
        email,
        password: await argon2.hash(password, {
          type: argon2.argon2id,
          memoryCost: 65536,
          timeCost: 3,
          parallelism: 4,
        }),
        isAdmin: false,
        rol: 'repartidor',
        rolId,
        deliveryPersonId: newDeliveryPerson.id,
        nombreCompleto: nombre,
        telefono: telefono || '',
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      await database.getCollection('users').insertOne(newUser);
      newDeliveryPerson.userId = newUser.id;
      await database.getCollection<DeliveryPerson>('deliveryPersons').updateOne(
        { id: newDeliveryPerson.id },
        { $set: { userId: newUser.id } }
      );

      res.status(201).json(newDeliveryPerson);
    } catch (error) {
      console.error('Error creating delivery person:', error);
      res.status(500).json({ error: 'Error al crear repartidor' });
    }
  }

async update(req: Request, res: Response): Promise<void> {
    try {
      const usuario = (req as any).user?.nombre || (req as any).user?.username || (req as any).user?.email || 'Sistema';
      const { nombre, telefono, activo, email, password, fotoDNI } = req.body;

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
      if (fotoDNI !== undefined) updateData.fotoDNI = fotoDNI;

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

      // Update user credentials if email/password provided
      if (email || password) {
        const userUpdate: any = {};
        let needsUpdate = false;

        if (email) {
          const existingUser = await database.getCollection('users').findOne({ email });
          if (existingUser && existingUser.id !== result.userId) {
            res.status(400).json({ error: 'Email ya existe' });
            return;
          }
          userUpdate.email = email;
          userUpdate.username = email;
          needsUpdate = true;
        }
        if (password) {
          userUpdate.password = await argon2.hash(password, {
            type: argon2.argon2id,
            memoryCost: 65536,
            timeCost: 3,
            parallelism: 4,
          });
          needsUpdate = true;
        }

        if (needsUpdate && result.userId) {
          await database.getCollection('users').updateOne(
            { id: result.userId },
            { $set: userUpdate }
          );
        }
      }

      await crearRegistro('Modificación', 'Repartidores', `Repartidor modificado: ${nombre || deliveryPersonAnterior.nombre}`, 
        { repartidorAnterior: deliveryPersonAnterior, repartidorNuevo: result, cambiosUsuario: { email, password: password ? '***' : undefined } }, usuario);

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

  async updateLocation(req: Request, res: Response): Promise<void> {
    try {
      const { id } = req.params;
      const { lat, lng } = req.body;

      if (typeof lat !== 'number' || typeof lng !== 'number') {
        res.status(400).json({ error: 'Latitud y longitud son requeridas' });
        return;
      }

      const updateData = {
        ultimaUbicacion: {
          lat,
          lng,
          timestamp: new Date(),
        },
        updatedAt: new Date(),
      };

      const result = await database
        .getCollection<DeliveryPerson>('deliveryPersons')
        .findOneAndUpdate(
          { id },
          { $set: updateData },
          { returnDocument: 'after' },
        );

      if (!result) {
        res.status(404).json({ error: 'Repartidor no encontrado' });
        return;
      }

      res.json(result);
    } catch (error) {
      console.error('Error updating delivery person location:', error);
      res.status(500).json({ error: 'Error al actualizar ubicación' });
    }
  }

  async updateDNI(req: Request, res: Response, fotoDNI: string): Promise<void> {
    try {
      const deliveryPerson = await database.getCollection<DeliveryPerson>('deliveryPersons').findOne({ id: req.params.id });
      if (!deliveryPerson) {
        res.status(404).json({ error: 'Repartidor no encontrado' });
        return;
      }

      const result = await database
        .getCollection<DeliveryPerson>('deliveryPersons')
        .findOneAndUpdate(
          { id: req.params.id },
          { $set: { fotoDNI, updatedAt: new Date() } },
          { returnDocument: 'after' },
        );

      res.json(result);
    } catch (error) {
      console.error('Error updating DNI photo:', error);
      res.status(500).json({ error: 'Error al actualizar foto de DNI' });
    }
  }

  async getOrderTracking(req: Request, res: Response): Promise<void> {
    try {
      const { orderId } = req.params;

      const order = await database.getCollection<Order>('orders').findOne({ id: orderId });
      if (!order) {
        res.status(404).json({ error: 'Pedido no encontrado' });
        return;
      }

      const deliveryPerson = order.deliveryPersonId
        ? await database.getCollection<DeliveryPerson>('deliveryPersons').findOne({ id: order.deliveryPersonId })
        : null;

      let directions = null;
      if (deliveryPerson?.ultimaUbicacion && order.latitud && order.longitud) {
        try {
          directions = await googleMapsService.getDirections(
            { lat: deliveryPerson.ultimaUbicacion.lat, lng: deliveryPerson.ultimaUbicacion.lng },
            { lat: order.latitud, lng: order.longitud },
          );
        } catch (e) {
          console.log('Error getting directions:', e);
        }
      }

res.json({
         order: {
           id: order.id,
           nombre: order.nombre,
           telefono: order.telefono,
           direccion: order.direccion,
           direccionCompleta: order.direccionCompleta,
           latitud: order.latitud,
           longitud: order.longitud,
           status: order.status,
           items: order.items,
           total: order.total,
           referencia: order.referencia,
           createdAt: order.createdAt,
         },
         deliveryPerson: deliveryPerson
           ? {
               id: deliveryPerson.id,
               nombre: deliveryPerson.nombre,
               ultimaUbicacion: deliveryPerson.ultimaUbicacion,
             }
           : null,
         directions,
       });
    } catch (error) {
      console.error('Error getting order tracking:', error);
      res.status(500).json({ error: 'Error al obtener seguimiento' });
    }
  }
}

export const deliveryController = new DeliveryController();