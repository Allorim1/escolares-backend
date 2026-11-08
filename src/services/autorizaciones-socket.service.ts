import { Namespace, Server } from 'socket.io';
import { jwtConfig } from '../config/jwt';

/**
 * Tiempo real de la app de supervisores (ion/escolares-pro), en su propio namespace
 * `/autorizaciones` del mismo socket.io (mismo /socket.io/ en nginx).
 *
 * Salas: `u:<id sellhub>` para los celulares vinculados de ese usuario de sellhub (el
 * principal y los secundarios), `e:<id escolares>` para la cuenta con sesión abierta en la
 * app (sirve mientras todavía no está vinculada, para avisarle al instante cuando la
 * vinculan) y `d:<id escolares>:<id celular>` para hablarle a un solo celular (QR escaneado,
 * dispositivo retirado).
 */
let nsp: Namespace | null = null;

export const salaUsuario = (sellhubUsuarioId: string) => `u:${sellhubUsuarioId}`;
export const salaEscolares = (escolaresUserId: string) => `e:${escolaresUserId}`;
const salaDispositivo = (escolaresUserId: string, dispositivoId: string) => `d:${escolaresUserId}:${dispositivoId}`;

export function registrarSocketAutorizaciones(
  io: Server,
  /** Usuario de sellhub del que este celular es principal o secundario (null si ninguno). */
  usuarioSellhubDe: (escolaresUserId: string, dispositivoId: string) => Promise<string | null>,
): void {
  nsp = io.of('/autorizaciones');

  // Mismo par token de escolares + id del celular que usan las rutas HTTP.
  nsp.use((socket, next) => {
    const usuario = jwtConfig.verifyAccessToken(socket.handshake.auth?.token);
    const dispositivoId = socket.handshake.auth?.dispositivoId;
    if (!usuario?.userId || typeof dispositivoId !== 'string' || !dispositivoId) {
      next(new Error('No autenticado'));
      return;
    }
    socket.data.escolaresUserId = usuario.userId;
    socket.data.dispositivoId = dispositivoId;
    next();
  });

  nsp.on('connection', async (socket) => {
    socket.join(salaEscolares(socket.data.escolaresUserId));
    socket.join(salaDispositivo(socket.data.escolaresUserId, socket.data.dispositivoId));
    try {
      const sellhubUsuarioId = await usuarioSellhubDe(socket.data.escolaresUserId, socket.data.dispositivoId);
      if (sellhubUsuarioId) socket.join(salaUsuario(sellhubUsuarioId));
    } catch (error) {
      console.error('Autorizaciones: error uniendo el socket a su sala:', error);
    }
  });
}

export function emitirAUsuarios(sellhubUsuarioIds: string[], evento: string, datos: unknown): void {
  if (!nsp || sellhubUsuarioIds.length === 0) return;
  nsp.to(sellhubUsuarioIds.map(salaUsuario)).emit(evento, datos);
}

export function emitirAEscolares(escolaresUserId: string, evento: string, datos: unknown): void {
  nsp?.to(salaEscolares(escolaresUserId)).emit(evento, datos);
}

/** Al desvincular, el celular sale de la sala del usuario de inmediato. */
export function sacarDeSalaUsuario(sellhubUsuarioId: string): void {
  nsp?.in(salaUsuario(sellhubUsuarioId)).socketsLeave(salaUsuario(sellhubUsuarioId));
}

export function emitirADispositivo(escolaresUserId: string, dispositivoId: string, evento: string, datos: unknown): void {
  nsp?.to(salaDispositivo(escolaresUserId, dispositivoId)).emit(evento, datos);
}

/** Al retirar un secundario, deja de recibir lo del usuario de inmediato. */
export function sacarDispositivoDeSalaUsuario(escolaresUserId: string, dispositivoId: string, sellhubUsuarioId: string): void {
  nsp?.in(salaDispositivo(escolaresUserId, dispositivoId)).socketsLeave(salaUsuario(sellhubUsuarioId));
}
