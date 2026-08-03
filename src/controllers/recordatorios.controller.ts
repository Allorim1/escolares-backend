import { Request, Response } from 'express';

export class RecordatoriosController {
  private async enviarWhatsAppTwilio(to: string, text: string): Promise<void> {
    const accountSid = process.env.TWILIO_ACCOUNT_SID;
    const authToken = process.env.TWILIO_AUTH_TOKEN || process.env.TWILIO_CLIENT_SECRET;
    const fromNumber = process.env.TWILIO_PHONE_NUMBER;

    if (!accountSid || !authToken || !fromNumber) {
      throw new Error('Faltan variables de entorno de Twilio');
    }

    const twilio = require('twilio');
    const client = twilio(accountSid, authToken);

    const cleanTo = to.replace(/\D/g, '');
    const cleanFrom = fromNumber.replace(/\D/g, '');

    await client.messages.create({
      body: text,
      from: `whatsapp:+${cleanFrom}`,
      to: `whatsapp:+${cleanTo}`,
    });
  }

  async enviarRecordatorioMasivo(req: Request, res: Response): Promise<void> {
    try {
      const { destinatarios } = req.body;
      if (!Array.isArray(destinatarios) || destinatarios.length === 0) {
        res.status(400).json({ error: 'Se requiere un array de destinatarios' });
        return;
      }

      const resultados = [];

      for (const destinatario of destinatarios) {
        try {
          await this.enviarWhatsAppTwilio(
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

      const texto = mensaje || 'Mensaje de prueba desde Relación de Cuentas';
      await this.enviarWhatsAppTwilio(telefono, texto);
      res.json({ success: true, message: 'Mensaje de prueba enviado correctamente' });
    } catch (error: any) {
      console.error('Error enviando test WhatsApp:', error);
      res.status(500).json({ error: error.message || 'Error al enviar mensaje de prueba' });
    }
  }
}

export const recordatoriosController = new RecordatoriosController();
