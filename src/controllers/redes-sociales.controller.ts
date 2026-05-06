import { Request, Response } from 'express';
import { database } from '../config/database';
import { RedSocial, MensajeRedSocial, RespuestaAutomatica, NotificacionRedSocial } from '../models';

export class RedesSocialesController {
  // Redes Sociales - CRUD
  async getRedesSociales(req: Request, res: Response): Promise<void> {
    try {
      const redes = await database
        .getCollection<RedSocial>('redes-sociales')
        .find({})
        .sort({ plataforma: 1 })
        .toArray();
      res.json(redes);
    } catch (error) {
      console.error('Error al obtener redes sociales:', error);
      res.status(500).json({ error: 'Error al obtener redes sociales' });
    }
  }

  async createRedSocial(req: Request, res: Response): Promise<void> {
    try {
      const { plataforma, usuario, token, habilitada } = req.body;

      if (!plataforma || !usuario) {
        res.status(400).json({ error: 'Plataforma y usuario son requeridos' });
        return;
      }

      const id = `red-${Date.now()}`;
      const now = new Date();

      const nuevaRedSocial: RedSocial = {
        id,
        plataforma,
        usuario,
        token: token || '',
        habilitada: habilitada || false,
        createdAt: now,
        updatedAt: now,
      };

      await database.getCollection<RedSocial>('redes-sociales').insertOne(nuevaRedSocial);
      res.status(201).json(nuevaRedSocial);
    } catch (error) {
      console.error('Error al crear red social:', error);
      res.status(500).json({ error: 'Error al crear red social' });
    }
  }

  async updateRedSocial(req: Request, res: Response): Promise<void> {
    try {
      const idParam = req.params.id;
      const id = Array.isArray(idParam) ? idParam[0] : idParam;
      const { plataforma, usuario, token, habilitada } = req.body;

      const updateData: Partial<RedSocial> = {
        updatedAt: new Date(),
      };

      if (plataforma !== undefined) updateData.plataforma = plataforma;
      if (usuario !== undefined) updateData.usuario = usuario;
      if (token !== undefined) updateData.token = token;
      if (habilitada !== undefined) updateData.habilitada = habilitada;

      const result = await database
        .getCollection<RedSocial>('redes-sociales')
        .findOneAndUpdate({ id }, { $set: updateData }, { returnDocument: 'after' });

      if (!result) {
        res.status(404).json({ error: 'Red social no encontrada' });
        return;
      }

      res.json(result);
    } catch (error) {
      console.error('Error al actualizar red social:', error);
      res.status(500).json({ error: 'Error al actualizar red social' });
    }
  }

  async deleteRedSocial(req: Request, res: Response): Promise<void> {
    try {
      const idParam = req.params.id;
      const id = Array.isArray(idParam) ? idParam[0] : idParam;

      const result = await database
        .getCollection<RedSocial>('redes-sociales')
        .deleteOne({ id });

      if (result.deletedCount === 0) {
        res.status(404).json({ error: 'Red social no encontrada' });
        return;
      }

      res.json({ message: 'Red social eliminada correctamente' });
    } catch (error) {
      console.error('Error al eliminar red social:', error);
      res.status(500).json({ error: 'Error al eliminar red social' });
    }
  }

  // Mensajes - CRUD
  async getMensajes(req: Request, res: Response): Promise<void> {
    try {
      const mensajes = await database
        .getCollection<MensajeRedSocial>('redes-sociales-mensajes')
        .find({})
        .sort({ fecha: -1 })
        .toArray();
      res.json(mensajes);
    } catch (error) {
      console.error('Error al obtener mensajes:', error);
      res.status(500).json({ error: 'Error al obtener mensajes' });
    }
  }

  async createMensaje(req: Request, res: Response): Promise<void> {
    try {
      const { plataforma, usuario, texto } = req.body;

      if (!plataforma || !usuario || !texto) {
        res.status(400).json({ error: 'Plataforma, usuario y texto son requeridos' });
        return;
      }

      const id = `msg-${Date.now()}`;
      const now = new Date();

      const nuevoMensaje: MensajeRedSocial = {
        id,
        plataforma,
        usuario,
        texto,
        fecha: now,
        leido: false,
        respondido: false,
        createdAt: now,
        updatedAt: now,
      };

      await database.getCollection<MensajeRedSocial>('redes-sociales-mensajes').insertOne(nuevoMensaje);
      res.status(201).json(nuevoMensaje);
    } catch (error) {
      console.error('Error al crear mensaje:', error);
      res.status(500).json({ error: 'Error al crear mensaje' });
    }
  }

  async updateMensaje(req: Request, res: Response): Promise<void> {
    try {
      const idParam = req.params.id;
      const id = Array.isArray(idParam) ? idParam[0] : idParam;
      const { leido, respondido, respuesta } = req.body;

      const updateData: Partial<MensajeRedSocial> = {
        updatedAt: new Date(),
      };

      if (leido !== undefined) updateData.leido = leido;
      if (respondido !== undefined) updateData.respondido = respondido;
      if (respuesta !== undefined) updateData.respuesta = respuesta;

      const result = await database
        .getCollection<MensajeRedSocial>('redes-sociales-mensajes')
        .findOneAndUpdate({ id }, { $set: updateData }, { returnDocument: 'after' });

      if (!result) {
        res.status(404).json({ error: 'Mensaje no encontrado' });
        return;
      }

      res.json(result);
    } catch (error) {
      console.error('Error al actualizar mensaje:', error);
      res.status(500).json({ error: 'Error al actualizar mensaje' });
    }
  }

  async deleteMensaje(req: Request, res: Response): Promise<void> {
    try {
      const idParam = req.params.id;
      const id = Array.isArray(idParam) ? idParam[0] : idParam;

      const result = await database
        .getCollection<MensajeRedSocial>('redes-sociales-mensajes')
        .deleteOne({ id });

      if (result.deletedCount === 0) {
        res.status(404).json({ error: 'Mensaje no encontrado' });
        return;
      }

      res.json({ message: 'Mensaje eliminado correctamente' });
    } catch (error) {
      console.error('Error al eliminar mensaje:', error);
      res.status(500).json({ error: 'Error al eliminar mensaje' });
    }
  }

  // Respuestas Automáticas - CRUD
  async getRespuestasAutomaticas(req: Request, res: Response): Promise<void> {
    try {
      const respuestas = await database
        .getCollection<RespuestaAutomatica>('redes-sociales-respuestas')
        .find({})
        .sort({ palabraClave: 1 })
        .toArray();
      res.json(respuestas);
    } catch (error) {
      console.error('Error al obtener respuestas automáticas:', error);
      res.status(500).json({ error: 'Error al obtener respuestas automáticas' });
    }
  }

  async createRespuestaAutomatica(req: Request, res: Response): Promise<void> {
    try {
      const { palabraClave, respuesta } = req.body;

      if (!palabraClave || !respuesta) {
        res.status(400).json({ error: 'Palabra clave y respuesta son requeridos' });
        return;
      }

      const id = `resp-${Date.now()}`;
      const now = new Date();

      const nuevaRespuesta: RespuestaAutomatica = {
        id,
        palabraClave,
        respuesta,
        createdAt: now,
        updatedAt: now,
      };

      await database.getCollection<RespuestaAutomatica>('redes-sociales-respuestas').insertOne(nuevaRespuesta);
      res.status(201).json(nuevaRespuesta);
    } catch (error) {
      console.error('Error al crear respuesta automática:', error);
      res.status(500).json({ error: 'Error al crear respuesta automática' });
    }
  }

  async updateRespuestaAutomatica(req: Request, res: Response): Promise<void> {
    try {
      const idParam = req.params.id;
      const id = Array.isArray(idParam) ? idParam[0] : idParam;
      const { palabraClave, respuesta } = req.body;

      const updateData: Partial<RespuestaAutomatica> = {
        updatedAt: new Date(),
      };

      if (palabraClave !== undefined) updateData.palabraClave = palabraClave;
      if (respuesta !== undefined) updateData.respuesta = respuesta;

      const result = await database
        .getCollection<RespuestaAutomatica>('redes-sociales-respuestas')
        .findOneAndUpdate({ id }, { $set: updateData }, { returnDocument: 'after' });

      if (!result) {
        res.status(404).json({ error: 'Respuesta automática no encontrada' });
        return;
      }

      res.json(result);
    } catch (error) {
      console.error('Error al actualizar respuesta automática:', error);
      res.status(500).json({ error: 'Error al actualizar respuesta automática' });
    }
  }

  async deleteRespuestaAutomatica(req: Request, res: Response): Promise<void> {
    try {
      const idParam = req.params.id;
      const id = Array.isArray(idParam) ? idParam[0] : idParam;

      const result = await database
        .getCollection<RespuestaAutomatica>('redes-sociales-respuestas')
        .deleteOne({ id });

      if (result.deletedCount === 0) {
        res.status(404).json({ error: 'Respuesta automática no encontrada' });
        return;
      }

      res.json({ message: 'Respuesta automática eliminada correctamente' });
    } catch (error) {
      console.error('Error al eliminar respuesta automática:', error);
      res.status(500).json({ error: 'Error al eliminar respuesta automática' });
    }
  }

  // Notificaciones - CRUD
  async getNotificaciones(req: Request, res: Response): Promise<void> {
    try {
      const notificaciones = await database
        .getCollection<NotificacionRedSocial>('redes-sociales-notificaciones')
        .find({})
        .sort({ tipo: 1 })
        .toArray();
      res.json(notificaciones);
    } catch (error) {
      console.error('Error al obtener notificaciones:', error);
      res.status(500).json({ error: 'Error al obtener notificaciones' });
    }
  }

  async createNotificacion(req: Request, res: Response): Promise<void> {
    try {
      const { tipo, canal, activa } = req.body;

      if (!tipo || !canal) {
        res.status(400).json({ error: 'Tipo y canal son requeridos' });
        return;
      }

      const id = `notif-${Date.now()}`;
      const now = new Date();

      const nuevaNotificacion: NotificacionRedSocial = {
        id,
        tipo,
        canal,
        activa: activa || false,
        createdAt: now,
        updatedAt: now,
      };

      await database.getCollection<NotificacionRedSocial>('redes-sociales-notificaciones').insertOne(nuevaNotificacion);
      res.status(201).json(nuevaNotificacion);
    } catch (error) {
      console.error('Error al crear notificación:', error);
      res.status(500).json({ error: 'Error al crear notificación' });
    }
  }

  async updateNotificacion(req: Request, res: Response): Promise<void> {
    try {
      const idParam = req.params.id;
      const id = Array.isArray(idParam) ? idParam[0] : idParam;
      const { tipo, canal, activa } = req.body;

      const updateData: Partial<NotificacionRedSocial> = {
        updatedAt: new Date(),
      };

      if (tipo !== undefined) updateData.tipo = tipo;
      if (canal !== undefined) updateData.canal = canal;
      if (activa !== undefined) updateData.activa = activa;

      const result = await database
        .getCollection<NotificacionRedSocial>('redes-sociales-notificaciones')
        .findOneAndUpdate({ id }, { $set: updateData }, { returnDocument: 'after' });

      if (!result) {
        res.status(404).json({ error: 'Notificación no encontrada' });
        return;
      }

      res.json(result);
    } catch (error) {
      console.error('Error al actualizar notificación:', error);
      res.status(500).json({ error: 'Error al actualizar notificación' });
    }
  }

  async deleteNotificacion(req: Request, res: Response): Promise<void> {
    try {
      const idParam = req.params.id;
      const id = Array.isArray(idParam) ? idParam[0] : idParam;

      const result = await database
        .getCollection<NotificacionRedSocial>('redes-sociales-notificaciones')
        .deleteOne({ id });

      if (result.deletedCount === 0) {
        res.status(404).json({ error: 'Notificación no encontrada' });
        return;
      }

      res.json({ message: 'Notificación eliminada correctamente' });
    } catch (error) {
      console.error('Error al eliminar notificación:', error);
      res.status(500).json({ error: 'Error al eliminar notificación' });
    }
  }
}

export const redesSocialesController = new RedesSocialesController();