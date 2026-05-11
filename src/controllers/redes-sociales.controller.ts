import { Request, Response } from 'express';
import { database } from '../config/database';
import { RedSocial, MensajeRedSocial, RespuestaAutomatica, NotificacionRedSocial } from '../models';

// Declarar tipos globales para Socket.IO
declare global {
  var io: any;
}

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
        .allowDiskUse(true)
        .toArray();
      res.json(mensajes);
    } catch (error) {
      console.error('Error al obtener mensajes:', error);
      res.status(500).json({ error: 'Error al obtener mensajes' });
    }
  }

  async createMensaje(req: Request, res: Response): Promise<void> {
    try {
      const { plataforma, usuario, texto, mediaType, mediaUrl, mediaCaption, mediaFilename } = req.body;

      if (!plataforma || !usuario) {
        res.status(400).json({ error: 'Plataforma y usuario son requeridos' });
        return;
      }

      // Si no hay texto ni media, es un error
      if (!texto && !mediaUrl) {
        res.status(400).json({ error: 'Se requiere texto o contenido multimedia' });
        return;
      }

      const id = `msg-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
      const now = new Date();

      const nuevoMensaje: MensajeRedSocial = {
        id,
        plataforma,
        usuario,
        texto: texto || undefined,
        fecha: now,
        leido: true, // Los mensajes que enviamos nosotros se marcan como leídos
        respondido: true, // Los mensajes que enviamos son respuestas
        mediaType: mediaType || undefined,
        mediaUrl: mediaUrl || undefined,
        mediaCaption: mediaCaption || undefined,
        mediaFilename: mediaFilename || undefined,
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
      const { leido, respondido, respuesta, mediaType, mediaUrl, mediaCaption, mediaFilename } = req.body;

      // Obtener el mensaje actual para conocer la plataforma y el usuario (destinatario)
      const mensaje = await database
        .getCollection<MensajeRedSocial>('redes-sociales-mensajes')
        .findOne({ id });

      if (!mensaje) {
        res.status(404).json({ error: 'Mensaje no encontrado' });
        return;
      }

      // Si se está marcando como respondido y hay una respuesta o media, enviar mensaje según la plataforma
      if (respondido === true && (respuesta || mediaUrl)) {
        if (mensaje.plataforma === 'WhatsApp') {
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
              respuestaLength: respuesta?.length || 0,
              mediaType,
              mediaUrl
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
            await this.sendWhatsAppMessage(whatsappConfig.usuario, whatsappConfig.token, mensaje.usuario, respuesta, mediaType, mediaUrl, mediaCaption, mediaFilename);
          } catch (error: any) {
            console.error('Error al enviar mensaje por WhatsApp:', error);
            res.status(500).json({ error: `Error al enviar mensaje por WhatsApp: ${error.message}` });
            return;
          }
        } else if (mensaje.plataforma === 'Instagram') {
          // Obtener la configuración de Instagram (red social con plataforma Instagram y habilitada)
          const instagramConfig = await database
            .getCollection<RedSocial>('redes-sociales')
            .findOne({ plataforma: 'Instagram', habilitada: true });

          if (!instagramConfig) {
            res.status(400).json({ error: 'Configuración de Instagram no encontrada o no habilitada' });
            return;
          }

          if (!instagramConfig.token || !instagramConfig.usuario) {
            res.status(400).json({ error: 'Token o ID de página (usuario) de Instagram no configurado' });
            return;
          }

          // Enviar mensaje por Instagram usando la API de Facebook Graph
          try {
            console.log('Instagram config:', {
              pageId: instagramConfig.usuario,
              tokenMasked: instagramConfig.token ? `${instagramConfig.token.substring(0, 5)}...` : 'empty',
              to: mensaje.usuario,
              respuestaLength: respuesta?.length || 0,
              mediaType,
              mediaUrl
            });
            // Validar que el token no esté vacío
            if (!instagramConfig.token || instagramConfig.token.trim() === '') {
              throw new Error('Token de acceso de Instagram no configurado o vacío');
            }
            await this.sendInstagramMessage(instagramConfig.usuario, instagramConfig.token, mensaje.usuario, respuesta, mediaType, mediaUrl, mediaCaption);
          } catch (error: any) {
            console.error('Error al enviar mensaje por Instagram:', error);
            res.status(500).json({ error: `Error al enviar mensaje por Instagram: ${error.message}` });
            return;
          }
        }
      }

      const updateData: Partial<MensajeRedSocial> = {
        updatedAt: new Date(),
      };

      if (leido !== undefined) updateData.leido = leido;
      if (respondido !== undefined) updateData.respondido = respondido;
      if (respuesta !== undefined) updateData.respuesta = respuesta;
      if (mediaType !== undefined) updateData.mediaType = mediaType;
      if (mediaUrl !== undefined) updateData.mediaUrl = mediaUrl;
      if (mediaCaption !== undefined) updateData.mediaCaption = mediaCaption;
      if (mediaFilename !== undefined) updateData.mediaFilename = mediaFilename;

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

  private async sendWhatsAppMessage(phoneNumberId: string, accessToken: string, to: string, text?: string, mediaType?: string, mediaUrl?: string, mediaCaption?: string, mediaFilename?: string): Promise<void> {
    // Trim and clean inputs
    const trimmedToken = accessToken.trim();
    const trimmedPhoneNumberId = phoneNumberId.trim();
    // Ensure phoneNumberId contains only digits (remove any non-numeric characters)
    const cleanPhoneNumberId = trimmedPhoneNumberId.replace(/\D/g, '');
    // Ensure recipient number contains only digits (remove any non-numeric characters including plus sign)
    const cleanTo = to.replace(/\D/g, '');
    
    // Log token details (masked) for debugging
    console.log('WhatsApp API details:', {
      phoneNumberId: trimmedPhoneNumberId,
      cleanPhoneNumberId,
      tokenLength: trimmedToken.length,
      tokenFirst5: trimmedToken.substring(0, 5) + '...',
      to,
      cleanTo,
      textLength: text?.length || 0
    });
    
    const url = `https://graph.facebook.com/v25.0/${cleanPhoneNumberId}/messages`;

    let payload: any = {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: cleanTo,
    };

    if (mediaUrl) {
      // Send media message
      payload.type = mediaType || 'image';
      payload[payload.type] = {
        link: mediaUrl,
      };
      if (mediaCaption) {
        payload[payload.type].caption = mediaCaption;
      }
      if (mediaFilename && payload.type === 'document') {
        payload[payload.type].filename = mediaFilename;
      }
    } else {
      // Send text message
      payload.type = 'text';
      payload.text = {
        preview_url: false,
        body: text || ''
      };
    }
    const logPayload = { ...payload };
    if (logPayload.text?.body) {
      logPayload.text.body = `${logPayload.text.body.substring(0, 50)}...`;
    }
    console.log('WhatsApp API request:', { url, payload: logPayload });
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${trimmedToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });
    if (!response.ok) {
      const errorText = await response.text();
      console.error('WhatsApp API error response:', errorText);
      let errorMessage = `WhatsApp API error: ${response.status}`;
      let errorCode: number = 0;
      let errorType = '';
      try {
        const errorJson = JSON.parse(errorText);
        if (errorJson.error) {
          errorMessage = `WhatsApp API error: ${errorJson.error.message || errorJson.error}`;
          errorCode = parseInt(errorJson.error.code, 10);
          errorType = errorJson.error.type;
          // Provide more specific guidance for authentication errors
          if (response.status === 401 || response.status === 403) {
            errorMessage += '. Verifica que el token de acceso y el ID del número de teléfono (Phone Number ID) sean correctos y tengan los permisos necesarios.';
            if (errorCode === 190) {
              errorMessage += ' El token de acceso puede haber expirado. Genera un nuevo token de acceso de larga duración en la configuración de la aplicación de Facebook.';
            }
            if (errorCode === 100) {
              errorMessage += ' El Phone Number ID puede ser incorrecto. Asegúrate de usar el ID numérico del número de teléfono de WhatsApp Business, no el número de teléfono mismo.';
            }
          }
        }
      } catch (e) {
        // If not JSON, keep raw error text
      }
      if (response.status === 401 || response.status === 403) {
        errorMessage += ' (Error de autenticación: token inválido o expirado, o Phone Number ID incorrecto)';
        errorMessage += ' Revisa la documentación de WhatsApp Business API: https://developers.facebook.com/docs/whatsapp/cloud-api/get-started#authenticate-your-requests';
      }
      throw new Error(errorMessage);
    }
  }

  private async sendInstagramMessage(pageId: string, accessToken: string, recipientId: string, text?: string, mediaType?: string, mediaUrl?: string, mediaCaption?: string): Promise<void> {
    // Limpiar y preparar los inputs
    const trimmedToken = accessToken.trim();
    const trimmedPageId = pageId.trim();

    console.log('Instagram API details:', {
      pageId: trimmedPageId,
      tokenLength: trimmedToken.length,
      tokenFirst5: trimmedToken.substring(0, 5) + '...',
      recipientId,
      textLength: text?.length || 0,
      mediaType,
      mediaUrl
    });

    // Validar token
    if (!trimmedToken || trimmedToken.trim() === '') {
      throw new Error('Token de acceso de Instagram no configurado o vacío');
    }

    let requestBody: any = {
      recipient: { id: recipientId },
    };

    if (mediaUrl) {
      // Enviar mensaje con media
      if (mediaType === 'image') {
        requestBody.message = {
          attachment: {
            type: 'image',
            payload: {
              url: mediaUrl,
            }
          }
        };
        if (mediaCaption) {
          // Para Instagram, el caption va en un mensaje separado después de la imagen
          // Primero enviamos la imagen, luego el texto si hay caption
        }
      } else if (mediaType === 'video') {
        requestBody.message = {
          attachment: {
            type: 'video',
            payload: {
              url: mediaUrl,
            }
          }
        };
      } else {
        // Para otros tipos o si no se especifica, enviar como texto
        requestBody.message = {
          text: text || 'Mensaje multimedia'
        };
      }
    } else {
      // Enviar mensaje de texto
      requestBody.message = {
        text: text || ''
      };
    }

    const url = `https://graph.facebook.com/v18.0/${trimmedPageId}/messages`;

    console.log('Instagram API request:', {
      url,
      requestBody: {
        ...requestBody,
        message: requestBody.message.text ? { text: `${requestBody.message.text.substring(0, 50)}...` } : requestBody.message
      }
    });

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${trimmedToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(requestBody),
      });

      if (!response.ok) {
        const errorText = await response.text();
        console.error('Instagram API error response:', errorText);
        let errorMessage = `Instagram API error: ${response.status}`;

        try {
          const errorJson = JSON.parse(errorText);
          if (errorJson.error) {
            errorMessage = `Instagram API error: ${errorJson.error.message || errorJson.error}`;
          }
        } catch (e) {
          // Mantener el mensaje de error original si no se puede parsear
        }

        throw new Error(errorMessage);
      }

      // Si hay media con caption, enviar el caption como mensaje separado
      if (mediaUrl && mediaCaption && (mediaType === 'image' || mediaType === 'video')) {
        await new Promise(resolve => setTimeout(resolve, 1000)); // Esperar 1 segundo

        const textRequestBody = {
          recipient: { id: recipientId },
          message: { text: mediaCaption }
        };

        const textResponse = await fetch(url, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${trimmedToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(textRequestBody),
        });

        if (!textResponse.ok) {
          console.warn('Error al enviar caption de Instagram, pero la media se envió correctamente');
        }
      }
    } catch (error: any) {
      console.error('Error en sendInstagramMessage:', error);
      throw error;
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

  // Webhook para verificación de Instagram
  async verifyInstagramWebhook(req: Request, res: Response): Promise<void> {
    const mode = req.query['hub.mode'] as string;
    const token = req.query['hub.verify_token'] as string;
    const challenge = req.query['hub.challenge'] as string;

    const verifyToken = process.env.INSTAGRAM_WEBHOOK_VERIFY_TOKEN || '';

    console.log('🔍 Verificación de webhook Instagram:');
    console.log('  - Mode:', mode);
    console.log('  - Token recibido:', token ? `${token.substring(0, 5)}...` : 'undefined');
    console.log('  - Challenge:', challenge);
    console.log('  - Token esperado:', verifyToken ? `${verifyToken.substring(0, 5)}...` : 'NO CONFIGURADO');

    if (!verifyToken) {
      console.error('❌ ERROR: INSTAGRAM_WEBHOOK_VERIFY_TOKEN no está configurado en las variables de entorno');
      res.sendStatus(500);
      return;
    }

    if (mode === 'subscribe' && token === verifyToken) {
      console.log('✅ Webhook de Instagram verificado exitosamente');
      res.status(200).send(challenge);
    } else {
      console.error('❌ Verificación de Instagram fallida:', {
        modeCorrecto: mode === 'subscribe',
        tokenCorrecto: token === verifyToken,
        razon: mode !== 'subscribe' ? 'Mode incorrecto' : 'Token incorrecto'
      });
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

                // Emitir evento de nuevo mensaje a todos los administradores conectados
                if (global.io) {
                  global.io.to('messages-admin').emit('nuevo-mensaje', nuevoMensaje);
                }

                // Emitir evento SSE a todos los clientes conectados
                if ((global as any).sseClients) {
                  const data = JSON.stringify({ type: 'nuevo-mensaje', mensaje: nuevoMensaje });
                  (global as any).sseClients.forEach((client: any) => {
                    try {
                      client.write(`data: ${data}\n\n`);
                    } catch (e) {
                      (global as any).sseClients.delete(client);
                    }
                  });
                }
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

  // Webhook para recibir mensajes de Instagram
  async webhookInstagram(req: Request, res: Response): Promise<void> {
    try {
      const body = req.body;
      console.log('=== WEBHOOK INSTAGRAM RECIBIDO ===');
      console.log('Headers:', req.headers);
      console.log('Body completo:', JSON.stringify(body, null, 2));

      // Verificar que es un evento de Instagram
      if (body.object !== 'instagram') {
        console.log('❌ Webhook no es de Instagram, objeto:', body.object);
        res.sendStatus(404);
        return;
      }

      console.log('✅ Webhook válido de Instagram detectado');

      // Procesar cada entrada
      for (const entry of body.entry || []) {
        console.log('📝 Procesando entry de Instagram:', JSON.stringify(entry, null, 2));

        // Para Instagram Messenger API (versión actual)
        for (const messaging of entry.messaging || []) {
          console.log('💬 Procesando messaging event:', JSON.stringify(messaging, null, 2));

          // Procesar mensajes de texto
          if (messaging.message?.text) {
            const from = messaging.sender?.id;
            const to = messaging.recipient?.id;
            const text = messaging.message.text;
            const messageId = messaging.message.mid;
            const timestamp = messaging.timestamp;

            console.log('✅ Mensaje de texto encontrado:', { from, to, text, messageId, timestamp });

            if (from && text) {
              const nuevoMensaje: MensajeRedSocial = {
                id: `msg-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
                plataforma: 'Instagram',
                usuario: from,
                texto: text,
                fecha: new Date(timestamp),
                leido: false,
                respondido: false,
                createdAt: new Date(),
                updatedAt: new Date(),
              };

await database
                 .getCollection<MensajeRedSocial>('redes-sociales-mensajes')
                 .insertOne(nuevoMensaje);
               console.log('💾 Mensaje de Instagram guardado:', nuevoMensaje);

               // Emitir evento de nuevo mensaje
               if (global.io) {
                 global.io.to('messages-admin').emit('nuevo-mensaje', nuevoMensaje);
               }

               // Emitir evento SSE a todos los clientes conectados
               if ((global as any).sseClients) {
                 const data = JSON.stringify({ type: 'nuevo-mensaje', mensaje: nuevoMensaje });
                 (global as any).sseClients.forEach((client: any) => {
                   try {
                     client.write(`data: ${data}\n\n`);
                   } catch (e) {
                     (global as any).sseClients.delete(client);
                   }
                 });
               }
            }
          }

          // Procesar mensajes con adjuntos
          if (messaging.message?.attachments) {
            const from = messaging.sender?.id;
            const attachments = messaging.message.attachments;
            const timestamp = messaging.timestamp;

            console.log('🖼️ Mensaje con adjuntos encontrado:', { from, attachments: attachments.length });

            for (const attachment of attachments) {
              if (attachment.type === 'image' && attachment.payload?.url && from) {
                const nuevoMensaje: MensajeRedSocial = {
                  id: `msg-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
                  plataforma: 'Instagram',
                  usuario: from,
                  texto: 'Imagen recibida',
                  mediaType: 'image',
                  mediaUrl: attachment.payload.url,
                  fecha: new Date(timestamp),
                  leido: false,
                  respondido: false,
                  createdAt: new Date(),
                  updatedAt: new Date(),
                };

await database
                   .getCollection<MensajeRedSocial>('redes-sociales-mensajes')
                   .insertOne(nuevoMensaje);
                 console.log('💾 Imagen de Instagram guardada:', nuevoMensaje);

                 // Emitir evento
                 if (global.io) {
                   global.io.to('messages-admin').emit('nuevo-mensaje', nuevoMensaje);
                 }

                 // Emitir evento SSE a todos los clientes conectados
                 if ((global as any).sseClients) {
                   const data = JSON.stringify({ type: 'nuevo-mensaje', mensaje: nuevoMensaje });
                   (global as any).sseClients.forEach((client: any) => {
                     try {
                       client.write(`data: ${data}\n\n`);
                     } catch (e) {
                       (global as any).sseClients.delete(client);
                     }
                   });
                 }
              }
            }
          }

          // Procesar postbacks (cuando usuario hace click en botones)
          if (messaging.postback) {
            const from = messaging.sender?.id;
            const payload = messaging.postback.payload;
            const timestamp = messaging.timestamp;

            console.log('🔘 Postback recibido:', { from, payload });

            if (from && payload) {
              const nuevoMensaje: MensajeRedSocial = {
                id: `msg-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
                plataforma: 'Instagram',
                usuario: from,
                texto: `Postback: ${payload}`,
                fecha: new Date(timestamp),
                leido: false,
                respondido: false,
                createdAt: new Date(),
                updatedAt: new Date(),
              };

              await database
                .getCollection<MensajeRedSocial>('redes-sociales-mensajes')
                .insertOne(nuevoMensaje);
              console.log('💾 Postback de Instagram guardado:', nuevoMensaje);
            }
          }
        }

        // Procesar cambios (formato alternativo - para versiones más antiguas)
        for (const change of entry.changes || []) {
          console.log('🔄 Procesando change (formato alternativo):', JSON.stringify(change, null, 2));

          if (change.field === 'messages' && change.value?.messages) {
            for (const message of change.value.messages) {
              console.log('📨 Procesando mensaje alternativo:', JSON.stringify(message, null, 2));

              if (message.message?.text) {
                const from = message.from?.id || message.sender?.id;
                const text = message.message.text;
                let timestamp = message.timestamp;

                // Ajustar timestamp si es necesario (algunas versiones envían en segundos)
                if (timestamp && timestamp < 1e10) {
                  timestamp = timestamp * 1000;
                }

                console.log('✅ Mensaje alternativo procesado:', { from, text, timestamp });

                if (from && text) {
                  const nuevoMensaje: MensajeRedSocial = {
                    id: `msg-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
                    plataforma: 'Instagram',
                    usuario: from,
                    texto: text,
                    fecha: new Date(timestamp),
                    leido: false,
                    respondido: false,
                    createdAt: new Date(),
                    updatedAt: new Date(),
                  };

                  await database
                    .getCollection<MensajeRedSocial>('redes-sociales-mensajes')
                    .insertOne(nuevoMensaje);
                  console.log('💾 Mensaje alternativo de Instagram guardado:', nuevoMensaje);

                  // Emitir evento
                  if (global.io) {
                    global.io.to('messages-admin').emit('nuevo-mensaje', nuevoMensaje);
                  }
                }
              }

              // Procesar adjuntos en formato alternativo
              if (message.message?.attachments) {
                const from = message.from?.id || message.sender?.id;
                const attachments = message.message.attachments;
                let timestamp = message.timestamp;

                if (timestamp && timestamp < 1e10) {
                  timestamp = timestamp * 1000;
                }

                console.log('🖼️ Adjuntos alternativos encontrados:', { from, attachments: attachments.length });

                for (const attachment of attachments) {
                  if (attachment.type === 'image' && attachment.payload?.url && from) {
                    const nuevoMensaje: MensajeRedSocial = {
                      id: `msg-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
                      plataforma: 'Instagram',
                      usuario: from,
                      texto: 'Imagen recibida (formato alternativo)',
                      mediaType: 'image',
                      mediaUrl: attachment.payload.url,
                      fecha: new Date(timestamp),
                      leido: false,
                      respondido: false,
                      createdAt: new Date(),
                      updatedAt: new Date(),
                    };

                    await database
                      .getCollection<MensajeRedSocial>('redes-sociales-mensajes')
                      .insertOne(nuevoMensaje);
                    console.log('💾 Imagen alternativa de Instagram guardada:', nuevoMensaje);
                  }
                }
              }
            }
          }
        }
      }

      // Responder 200 OK a Meta
      console.log(`✅ Webhook de Instagram procesado exitosamente - ${body.entry?.length || 0} entries procesadas`);
      res.sendStatus(200);
    } catch (error) {
      console.error('❌ Error procesando webhook de Instagram:', error);
      res.sendStatus(500);
    }
  }

  // Store connected SSE clients
  private sseClients: Set<any> = new Set();

  // Register SSE client
  registerSSEClient(res: any): void {
    this.sseClients.add(res);
  }

  // Remove SSE client
  unregisterSSEClient(res: any): void {
    this.sseClients.delete(res);
  }

  // Emit message to all SSE clients
  emitMessageToSSEClients(mensaje: MensajeRedSocial): void {
    const data = JSON.stringify({ type: 'nuevo-mensaje', mensaje });
    this.sseClients.forEach(client => {
      try {
        client.write(`data: ${data}\n\n`);
      } catch (e) {
        this.sseClients.delete(client);
      }
    });
  }

  // Verificar configuración de webhooks
  async checkWebhookConfig(req: Request, res: Response): Promise<void> {
    try {
      const config = {
        instagram: {
          webhook_verify_token: process.env.INSTAGRAM_WEBHOOK_VERIFY_TOKEN ? 'CONFIGURADO' : 'NO CONFIGURADO',
          webhook_url: `${req.protocol}://${req.get('host')}/api/redes-sociales/webhook/instagram`,
          test_endpoint: `${req.protocol}://${req.get('host')}/api/redes-sociales/test-webhook`
        },
        database: {
          connected: !!(global as any).db,
          messages_collection_exists: false
        },
        socket: {
          io_available: !!(global as any).io
        }
      };

      // Verificar si existe la colección de mensajes
      try {
        const collections = await (global as any).db.listCollections().toArray();
        config.database.messages_collection_exists = collections.some((c: any) => c.name === 'redes-sociales-mensajes');
      } catch (e) {
        // Ignorar error
      }

      res.json(config);
    } catch (error) {
      console.error('Error verificando configuración:', error);
      res.status(500).json({ error: 'Error al verificar configuración' });
    }
  }
}

export const redesSocialesController = new RedesSocialesController();