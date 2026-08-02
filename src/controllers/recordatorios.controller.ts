import { Request, Response } from 'express';
import { database } from '../config/database';

export class RecordatoriosController {
  async enviarRecordatorioMasivo(req: Request, res: Response): Promise<void> {
    try {
      const { destinatarios } = req.body;
      if (!Array.isArray(destinatarios) || destinatarios.length === 0) {
        res.status(400).json({ error: 'Se requiere un array de destinatarios' });
        return;
      }

      const accountSid = process.env.TWILIO_ACCOUNT_SID;
      const authToken = process.env.TWILIO_AUTH_TOKEN;
      const fromNumber = process.env.TWILIO_PHONE_NUMBER;

      if (!accountSid || !authToken || !fromNumber) {
        res.status(500).json({ error: 'Twilio no está configurado' });
        return;
      }

      const twilio = require('twilio');
      const client = twilio(accountSid, authToken);
      const resultados = [];

      for (const destinatario of destinatarios) {
        try {
          const telefono = destinatario.telefono.replace(/\D/g, '');
          await client.messages.create({
            body: `Hola ${destinatario.nombre}, te recordamos que tienes una relación de cuentas pendiente. Por favor, comunícate con nosotros para más información.`,
            from: fromNumber,
            to: `+58${telefono}`,
          });
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
}

export const recordatoriosController = new RecordatoriosController();
