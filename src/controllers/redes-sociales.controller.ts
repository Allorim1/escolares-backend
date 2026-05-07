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

      // Obtener el mensaje actual para conocer la plataforma y el usuario (destinatario)
      const mensaje = await database
        .getCollection<MensajeRedSocial>('redes-sociales-mensajes')
        .findOne({ id });

      if (!mensaje) {
        res.status(404).json({ error: 'Mensaje no encontrado' });
        return;
      }

      // Si se está marcando como respondido y hay una respuesta, y la plataforma es WhatsApp, enviar mensaje
      if (respondido === true && respuesta && mensaje.plataforma === 'WhatsApp') {
        // Obtener la configuración de WhatsApp (red social con plataforma WhatsApp y habilitada)
        const whatsappConfig = await database
          .getCollection<RedSocial>('redes-sociales')
          .findOne({ plataforma: 'WhatsApp', habilitada: true });

        if (!whatsappConfig) {
          res.status(400).json({ error: 'Configuración de WhatsApp no encontrada o no habilitada' });
          return;
        }

        if (!whatsappConfig.token || !whatsappConfig.usuario) {
          res.status(400).json({ error: 'Token o número de teléfono (usuario) de WhatsApp no configurado' });
          return;
        }

        // Enviar mensaje por WhatsApp usando la API de Facebook Graph
        try {
          console.log('WhatsApp config:', {
            phoneNumberId: whatsappConfig.usuario,
            phoneNumberIdLength: whatsappConfig.usuario?.length,
            tokenMasked: whatsappConfig.token ? `${whatsappConfig.token.substring(0, 5)}...` : 'empty',
            tokenLength: whatsappConfig.token?.length,
            to: mensaje.usuario,
            respuestaLength: respuesta.length
          });
          // Validar que el token no esté vacío
          if (!whatsappConfig.token || whatsappConfig.token.trim() === '') {
            throw new Error('Token de acceso de WhatsApp no configurado o vacío');
          }
          // Validar que el phoneNumberId sea un número válido (solo dígitos)
          const phoneNumberIdDigits = whatsappConfig.usuario.replace(/\D/g, '');
          if (!phoneNumberIdDigits || phoneNumberIdDigits.length < 10) {
            throw new Error('El ID del número de teléfono de WhatsApp parece inválido. Debe ser un número de teléfono ID (solo dígitos)');
          }
          await this.sendWhatsAppMessage(whatsappConfig.usuario, whatsappConfig.token, mensaje.usuario, respuesta);
        } catch (error: any) {
          console.error('Error al enviar mensaje por WhatsApp:', error);
          res.status(500).json({ error: `Error al enviar mensaje por WhatsApp: ${error.message}` });
          return;
        }
      }

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

  private async sendWhatsAppMessage(phoneNumberId: string, accessToken: string, to: string, text: string): Promise<void> {
    // Ensure phoneNumberId contains only digits (remove any non-numeric characters)
    const cleanPhoneNumberId = phoneNumberId.replace(/\D/g, '');
    // Ensure recipient number contains only digits (remove any non-numeric characters including plus sign)
    const cleanTo = to.replace(/\D/g, '');
    
    const url = `https://graph.facebook.com/v25.0/${cleanPhoneNumberId}/messages`;
    const payload = {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: cleanTo,
      type: 'text',
      text: {
        preview_url: false,
        body: text
      }
    };
    console.log('WhatsApp API request:', { url, payload });
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });
    if (!response.ok) {
      const errorText = await response.text();
      console.error('WhatsApp API error response:', errorText);
      let errorMessage = `WhatsApp API error: ${response.status}`;
      try {
        const errorJson = JSON.parse(errorText);
        if (errorJson.error && errorJson.error.message) {
          errorMessage = `WhatsApp API error: ${errorJson.error.message}`;
          // Provide more specific guidance for authentication errors
          if (response.status === 401 || response.status === 403) {
            errorMessage += '. Verifica que el token de acceso y el ID del número de teléfono (Phone Number ID) sean correctos y tengan los permisos necesarios.';
          }
        }
      } catch (e) {
        // If not JSON, keep raw error text
      }
      if (response.status === 401 || response.status === 403) {
        errorMessage += ' (Error de autenticación: token inválido o expirado, o Phone Number ID incorrecto)';
      }
      throw new Error(errorMessage);
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

  // Webhook para verificación de WhatsApp
  async verifyWebhook(req: Request, res: Response): Promise<void> {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];

    const verifyToken = process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN || '';

    console.log('Webhook verification request:', { mode, token, challenge, verifyToken });

    if (mode === 'subscribe' && token === verifyToken) {
      console.log('Webhook verificado exitosamente');
      res.status(200).send(challenge);
    } else {
      console.error('Verificación fallida: token mismatch or missing parameters');
      res.sendStatus(403);
    }
  }

  // Webhook para recibir mensajes de WhatsApp
  async webhookWhatsApp(req: Request, res: Response): Promise<void> {
    try {
      const body = req.body;
      console.log('Webhook recibido:', JSON.stringify(body, null, 2));

      // Verificar que es un evento de WhatsApp
      if (body.object !== 'whatsapp_business_account') {
        res.sendStatus(404);
        return;
      }

      // Procesar cada entrada
      for (const entry of body.entry || []) {
        for (const change of entry.changes || []) {
          if (change.field === 'messages') {
            const messages = change.value?.messages || [];
            for (const message of messages) {
              if (message.type === 'text') {
                const from = message.from; // número de teléfono del remitente
                const text = message.text?.body;
                const messageId = message.id;
                const timestamp = parseInt(message.timestamp) * 1000; // convertir a milisegundos

                // Crear mensaje en la base de datos
                const nuevoMensaje: MensajeRedSocial = {
                  id: `msg-${Date.now()}`,
                  plataforma: 'WhatsApp',
                  usuario: from,
                  texto: text || '',
                  fecha: new Date(timestamp),
                  leido: false,
                  respondido: false,
                  createdAt: new Date(),
                  updatedAt: new Date(),
                };

                await database
                  .getCollection<MensajeRedSocial>('redes-sociales-mensajes')
                  .insertOne(nuevoMensaje);
                console.log('Mensaje de WhatsApp guardado:', nuevoMensaje);
              }
            }
          }
        }
      }

      // Responder 200 OK a Meta
      res.sendStatus(200);
    } catch (error) {
      console.error('Error procesando webhook de WhatsApp:', error);
      res.sendStatus(500);
    }
  }
}

export const redesSocialesController = new RedesSocialesController();