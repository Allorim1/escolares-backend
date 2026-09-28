import { Request } from 'express';
import { Server } from 'socket.io';

/**
 * Avisa en tiempo real (socket.io) que un ticket del Centro de Ayuda cambió: a quien tenga
 * abierto ese ticket (sala `ticket-<id>`, la app o el panel) y a la lista del panel admin
 * (sala `tickets-admin`). Solo viaja el id, no el contenido: cada lado lo vuelve a pedir por
 * su API autenticada, así unirse a una sala no expone mensajes de nadie.
 */
export function avisarTicketActualizado(req: Request, ticketId: string): void {
  const io: Server | undefined = req.app.get('io');
  io?.to(`ticket-${ticketId}`).to('tickets-admin').emit('ticket-actualizado', { ticketId });
}
