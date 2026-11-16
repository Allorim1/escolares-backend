import { Namespace, Server } from 'socket.io';
import { jwtConfig } from '../config/jwt';

/**
 * Tiempo real de la app de supervisores (ion/escolares-pro), en su propio namespace
 * `/autorizaciones` del mismo socket.io (mismo /socket.io/ en nginx).
 *
 * Salas: `u:<tienda>:<id sellhub>` para los celulares vinculados de ese usuario de sellhub
 * en esa tienda (el principal y los secundarios de la cuenta; un celular está en la sala de
 * cada tienda donde su cuenta está vinculada), `e:<id escolares>` para la cuenta con sesión
 * abierta en la app (sirve mientras todavía no está vinculada, para avisarle al instante
 * cuando la vinculan) y `d:<id escolares>:<id celular>` para hablarle a un solo celular (QR
 * escaneado, dispositivo retirado).
 */
let nsp: Namespace | null = null;

/** `usuario` es el id interno `tienda:usuario` (ver autorizaciones-tiendas.service.ts). */
export const salaUsuario = (usuario: string) => `u:${usuario}`;
export const salaEscolares = (escolaresUserId: string) => `e:${escolaresUserId}`;
const salaDispositivo = (escolaresUserId: string, dispositivoId: string) => `d:${escolaresUserId}:${dispositivoId}`;

export function registrarSocketAutorizaciones(
  io: Server,
  /** Usuarios (ids internos) de los que este celular es principal o secundario: uno por tienda. */
  usuariosSellhubDe: (escolaresUserId: string, dispositivoId: string) => Promise<string[]>,
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
    socket.data.conectadoEn = Date.now();
    socket.data.pantalla = '';
    // En qué pantalla de la app está (Resumen, Autorizaciones…): la ven los root en "Celulares conectados".
    socket.on('pantalla:actual', (texto: unknown) => {
      socket.data.pantalla = typeof texto === 'string' ? texto.trim().slice(0, 40) : '';
    });
    socket.join(salaEscolares(socket.data.escolaresUserId));
    socket.join(salaDispositivo(socket.data.escolaresUserId, socket.data.dispositivoId));
    try {
      const usuarios = await usuariosSellhubDe(socket.data.escolaresUserId, socket.data.dispositivoId);
      if (usuarios.length) socket.join(usuarios.map(salaUsuario));
    } catch (error) {
      console.error('Autorizaciones: error uniendo el socket a su sala:', error);
    }
  });
}

export function emitirAUsuarios(usuarios: string[], evento: string, datos: unknown): void {
  if (!nsp || usuarios.length === 0) return;
  nsp.to(usuarios.map(salaUsuario)).emit(evento, datos);
}

export function emitirAEscolares(escolaresUserId: string, evento: string, datos: unknown): void {
  nsp?.to(salaEscolares(escolaresUserId)).emit(evento, datos);
}

/** Al desvincular, el celular sale de la sala de ese usuario (de esa tienda) de inmediato. */
export function sacarDeSalaUsuario(usuario: string): void {
  nsp?.in(salaUsuario(usuario)).socketsLeave(salaUsuario(usuario));
}

/** Al vincular otra tienda, los celulares de la cuenta que ya están conectados entran a su sala. */
export function unirDispositivosASala(escolaresUserId: string, dispositivoIds: string[], usuario: string): void {
  if (!nsp || dispositivoIds.length === 0) return;
  nsp.in(dispositivoIds.map((d) => salaDispositivo(escolaresUserId, d))).socketsJoin(salaUsuario(usuario));
}

export function emitirADispositivo(escolaresUserId: string, dispositivoId: string, evento: string, datos: unknown): void {
  nsp?.to(salaDispositivo(escolaresUserId, dispositivoId)).emit(evento, datos);
}

/** Al retirar un secundario, deja de recibir lo de todas las tiendas de la cuenta de inmediato. */
export function sacarDispositivoDeSalas(escolaresUserId: string, dispositivoId: string, usuarios: string[]): void {
  if (!nsp || usuarios.length === 0) return;
  nsp.in(salaDispositivo(escolaresUserId, dispositivoId)).socketsLeave(usuarios.map(salaUsuario));
}

export interface CelularConectado {
  escolaresUserId: string;
  dispositivoId: string;
  pantalla: string;
  conectadoEn: number;
}

/** Celulares con la app abierta ahora (uno por celular: el socket más reciente). */
export function celularesConectados(): CelularConectado[] {
  if (!nsp) return [];
  const porCelular = new Map<string, CelularConectado>();
  for (const socket of nsp.sockets.values()) {
    const d = socket.data as { escolaresUserId?: string; dispositivoId?: string; pantalla?: string; conectadoEn?: number };
    if (!d.escolaresUserId || !d.dispositivoId) continue;
    const previo = porCelular.get(d.dispositivoId);
    if (previo && previo.conectadoEn > (d.conectadoEn ?? 0)) continue;
    porCelular.set(d.dispositivoId, {
      escolaresUserId: d.escolaresUserId,
      dispositivoId: d.dispositivoId,
      pantalla: d.pantalla ?? '',
      conectadoEn: d.conectadoEn ?? Date.now(),
    });
  }
  return [...porCelular.values()];
}
