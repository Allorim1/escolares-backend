import { Request, Response } from 'express';
import { database } from '../config/database';

export class RecordatoriosController {
  private async sendWhatsAppMessage(phoneNumberId: string, accessToken: string, to: string, text?: string): Promise<void> {
    const trimmedToken = accessToken.trim();
    const cleanPhoneNumberId = phoneNumberId.replace(/\D/g, '');
    const cleanTo = to.replace(/\D/g, '');

    const url = `https://graph.facebook.com/v25.0/${cleanPhoneNumberId}/messages`;

    const cleanText = (text || '').trim().replace(/(\.{3,}|…)\s*$/u, '').trim();
    const payload: any = {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: cleanTo,
      type: 'text',
      text: { body: cleanText },
    };

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
      let errorMessage = `WhatsApp API error: ${response.status}`;
      try {
        const errorJson = JSON.parse(errorText);
        if (errorJson.error) {
          errorMessage = `WhatsApp API error: ${errorJson.error.message || errorJson.error}`;
        }
      } catch (e) {}
      throw new Error(errorMessage);
    }
  }

  async enviarRecordatorioMasivo(req: Request, res: Response): Promise<void> {
    try {
      const { destinatarios } = req.body;
      if (!Array.isArray(destinatarios) || destinatarios.length === 0) {
        res.status(400).json({ error: 'Se requiere un array de destinatarios' });
        return;
      }

      const config = await database.getCollection('redes-sociales').findOne({ plataforma: 'whatsapp' });
      if (!config || !config.token || !config.usuario) {
        res.status(500).json({ error: 'WhatsApp no está configurado' });
        return;
      }

      const phoneNumberId = config.usuario;
      const accessToken = config.token;
      const resultados = [];

      for (const destinatario of destinatarios) {
        try {
          await this.sendWhatsAppMessage(
            phoneNumberId,
            accessToken,
            destinatario.telefono,
            `Hola ${destinatario.nombre}, te recordamos que tienes una relación de cuentas pendiente. Por favor, comunícate con nosotros para más información.`
          );
          resultados.push({ telefono: destinatario.telefono, nombre: destinatario.nombre, enviado: true });
        } catch (error: any) {
          resultados.push({ telefono: destinatario.telefono, nombre: destinatario.nombre, enviado: false, error: error.message || String(error) });
        }
      }

      res.json({ success: true, resultados });
    } catch (error) {
      console.error('Error enviando recordatorios masivos:', error);
      res.status(500).json({ error: 'Error al enviar recordatorios' });
    }
  }

  async enviarTestWhatsApp(req: Request, res: Response): Promise<void> {
    try {
      const { telefono, mensaje } = req.body;
      if (!telefono) {
        res.status(400).json({ error: 'Se requiere el teléfono' });
        return;
      }

      const config = await database.getCollection('redes-sociales').findOne({ plataforma: 'whatsapp' });
      if (!config || !config.token || !config.usuario) {
        res.status(500).json({ error: 'WhatsApp no está configurado' });
        return;
      }

      const phoneNumberId = config.usuario;
      const accessToken = config.token;
      const texto = mensaje || 'Mensaje de prueba desde Relación de Cuentas';

      await this.sendWhatsAppMessage(phoneNumberId, accessToken, telefono, texto);
      res.json({ success: true, message: 'Mensaje de prueba enviado correctamente' });
    } catch (error: any) {
      console.error('Error enviando test WhatsApp:', error);
      res.status(500).json({ error: error.message || 'Error al enviar mensaje de prueba' });
    }
  }
}

export const recordatoriosController = new RecordatoriosController();
