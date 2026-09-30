import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { Server, Socket } from 'socket.io';
import { database } from '../config/database';
import { jwtConfig, TokenPayload } from '../config/jwt';
import {
  Rol,
  User,
  UserSession,
  WhatsAppCita,
  WhatsAppConversacion,
  WhatsAppEstadoMensaje,
  WhatsAppMedia,
  WhatsAppMensaje,
  WhatsAppTipoMensaje,
} from '../models';
import {
  descargarMedia,
  enviarMedia,
  enviarTexto,
  marcarLeido,
  subirMedia,
  TipoMediaSaliente,
  WhatsAppApiError,
} from './whatsapp-api.service';

export const WHATSAPP_PERMISO = 'whatsapp_gestionar';
const SALA = 'whatsapp';

const conversaciones = () => database.getCollection<WhatsAppConversacion>('whatsapp-conversaciones');
const mensajes = () => database.getCollection<WhatsAppMensaje>('whatsapp-mensajes');

// ---------------------------------------------------------------------------
// Permisos
// ---------------------------------------------------------------------------

/** Root siempre; el resto necesita el permiso 'whatsapp_gestionar' en su rol. */
export async function puedeUsarWhatsApp(user: TokenPayload | undefined): Promise<boolean> {
  if (!user) return false;
  if (user.rol === 'root') return true;
  const usuario = await database.getCollection<User>('users').findOne({ id: user.userId });
  if (!usuario?.rolId) return false;
  const rol = await database.getCollection<Rol>('roles').findOne({ id: usuario.rolId });
  return !!rol?.permisos?.includes(WHATSAPP_PERMISO);
}

// ---------------------------------------------------------------------------
// Tiempo real (socket.io)
// ---------------------------------------------------------------------------

function leerCookie(header: string | undefined, nombre: string): string | undefined {
  const par = header?.split(';').map((c) => c.trim()).find((c) => c.startsWith(`${nombre}=`));
  return par ? decodeURIComponent(par.slice(nombre.length + 1)) : undefined;
}

/**
 * A diferencia de las demás salas, a 'whatsapp' viaja el contenido completo de los
 * mensajes (así el panel se actualiza sin volver a pedir nada). Por eso unirse exige
 * un access token válido, sesión activa y el permiso de WhatsApp.
 */
export function registrarSocketWhatsApp(io: Server): void {
  io.on('connection', (socket: Socket) => {
    socket.on('join-whatsapp-room', async (token: unknown, ack?: (r: { ok: boolean; error?: string }) => void) => {
      const responder = typeof ack === 'function' ? ack : () => undefined;
      try {
        // Igual que authenticateToken: vale la cookie o el token del cliente, el que sea
        // válido. El de localStorage puede estar vencido mientras la cookie sigue vigente
        // (el REST funciona con la cookie y nunca fuerza a renovarlo).
        const candidatos = [leerCookie(socket.handshake.headers.cookie, 'accessToken'), typeof token === 'string' ? token : undefined];
        let accessToken: string | undefined;
        let payload: TokenPayload | null = null;
        for (const c of candidatos) {
          payload = c ? jwtConfig.verifyAccessToken(c) : null;
          if (payload) {
            accessToken = c;
            break;
          }
        }
        if (!accessToken || !payload) {
          console.warn(`Socket ${socket.id} rechazado en la sala de WhatsApp: token ausente o vencido`);
          return responder({ ok: false, error: 'No autenticado' });
        }

        const sessionId = jwtConfig.deriveSessionId(accessToken, payload);
        const session = await database.getCollection<UserSession>('sessions').findOne({ id: sessionId });
        if (session && !session.active) return responder({ ok: false, error: 'Sesión cerrada' });

        if (!(await puedeUsarWhatsApp(payload))) return responder({ ok: false, error: 'Sin permiso' });
        socket.join(SALA);
        console.log(`Socket ${socket.id} unido a la sala de WhatsApp (${payload.nombre || payload.email})`);
        responder({ ok: true });
      } catch (error) {
        console.error('Error uniendo socket a la sala de WhatsApp:', error);
        responder({ ok: false, error: 'Error interno' });
      }
    });
    socket.on('leave-whatsapp-room', () => socket.leave(SALA));
  });
}

function emitirMensaje(io: Server | undefined, mensaje: WhatsAppMensaje, conversacion?: WhatsAppConversacion | null) {
  if (!io) console.warn('WhatsApp: socket.io no disponible, el mensaje no se publicó en tiempo real');
  io?.to(SALA).emit('wa:mensaje', { mensaje: limpiar(mensaje), conversacion: conversacion ? limpiar(conversacion) : undefined });
}

function emitirConversacion(io: Server | undefined, conversacion: WhatsAppConversacion) {
  io?.to(SALA).emit('wa:conversacion', { conversacion: limpiar(conversacion) });
}

function limpiar<T extends { _id?: unknown }>(doc: T): Omit<T, '_id'> {
  const { _id, ...resto } = doc;
  return resto;
}

// ---------------------------------------------------------------------------
// Archivos (privados: solo se sirven por /api/whatsapp/media/:id con permiso)
// ---------------------------------------------------------------------------

const uploadsRoot = process.env.UPLOADS_PATH ? path.resolve(process.env.UPLOADS_PATH) : path.resolve(process.cwd(), 'uploads');
export const WHATSAPP_UPLOADS_ROOT = path.join(uploadsRoot, 'whatsapp');

const EXTENSION_POR_MIME: Record<string, string> = {
  'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/gif': '.gif',
  'video/mp4': '.mp4', 'video/3gpp': '.3gp',
  'audio/ogg': '.ogg', 'audio/mpeg': '.mp3', 'audio/mp4': '.m4a', 'audio/aac': '.aac', 'audio/amr': '.amr',
  'application/pdf': '.pdf',
  'application/msword': '.doc',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
  'application/vnd.ms-excel': '.xls',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '.xlsx',
  'application/vnd.ms-powerpoint': '.ppt',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': '.pptx',
  'text/plain': '.txt',
};

/** 'audio/ogg; codecs=opus' -> 'audio/ogg' */
export function mimeBase(mimetype: string): string {
  return mimetype.split(';')[0].trim().toLowerCase();
}

function guardarArchivo(buffer: Buffer, mimetype: string, nombreOriginal?: string): string {
  const mes = new Date().toISOString().slice(0, 7);
  const carpeta = path.join(WHATSAPP_UPLOADS_ROOT, mes);
  fs.mkdirSync(carpeta, { recursive: true });
  const ext = EXTENSION_POR_MIME[mimeBase(mimetype)] || path.extname(nombreOriginal || '').toLowerCase().replace(/[^.a-z0-9]/g, '') || '.bin';
  const nombre = `${crypto.randomUUID()}${ext}`;
  fs.writeFileSync(path.join(carpeta, nombre), buffer);
  return path.posix.join(mes, nombre);
}

/** Ruta absoluta del archivo guardado, validando que no se salga de uploads/whatsapp. */
export function rutaArchivo(relativa: string): string | null {
  const resuelta = path.resolve(WHATSAPP_UPLOADS_ROOT, relativa);
  return resuelta.startsWith(WHATSAPP_UPLOADS_ROOT + path.sep) ? resuelta : null;
}

// ---------------------------------------------------------------------------
// Conversaciones
// ---------------------------------------------------------------------------

function resumen(m: WhatsAppMensaje): WhatsAppConversacion['ultimoMensaje'] {
  return { id: m.id, direccion: m.direccion, tipo: m.tipo, texto: m.texto, estado: m.estado, fecha: m.fecha };
}

function citaDe(m: WhatsAppMensaje): WhatsAppCita {
  return { id: m.id, direccion: m.direccion, tipo: m.tipo, texto: m.texto?.slice(0, 200) };
}

/**
 * Busca en Relación de Cuentas (abonos-polar) un cliente con ese teléfono. Los teléfonos
 * allí se escriben a mano ("0414-123.45.67", "+58 414 1234567"...), así que se comparan
 * los últimos 10 dígitos permitiendo cualquier separador entre ellos.
 */
async function buscarCliente(waId: string): Promise<WhatsAppConversacion['cliente']> {
  const digitos = waId.replace(/\D/g, '').slice(-10);
  if (digitos.length < 10) return undefined;
  const patron = new RegExp(`${digitos.split('').join('\\D*')}\\D*$`);
  const doc: any = await database.getCollection('abonos-polar').findOne(
    { telefono: { $regex: patron } },
    { sort: { _id: -1 }, projection: { nombre: 1, empresa: 1, planta: 1, cedula: 1 } },
  );
  if (!doc) return undefined;
  return { nombre: doc.nombre, empresa: doc.empresa, planta: doc.planta, cedula: doc.cedula };
}

async function completarCliente(conv: WhatsAppConversacion | null): Promise<WhatsAppConversacion | null> {
  if (!conv || conv.clienteBuscado) return conv;
  let cliente: WhatsAppConversacion['cliente'];
  try {
    cliente = await buscarCliente(conv.waId);
  } catch (error) {
    console.error('Error buscando cliente de WhatsApp en abonos-polar:', error);
  }
  return conversaciones().findOneAndUpdate(
    { waId: conv.waId },
    { $set: { clienteBuscado: true, ...(cliente ? { cliente } : {}) } },
    { returnDocument: 'after' },
  );
}

/** Registra un mensaje nuevo en la conversación (creándola si no existe) y devuelve la conversación actualizada. */
async function registrarEnConversacion(m: WhatsAppMensaje, nombrePerfil?: string): Promise<WhatsAppConversacion | null> {
  const set: Partial<WhatsAppConversacion> = { ultimoMensaje: resumen(m), updatedAt: m.fecha };
  if (nombrePerfil) set.nombre = nombrePerfil;
  if (m.direccion === 'entrante') set.ultimoEntranteEn = m.fecha;

  const conv = await conversaciones().findOneAndUpdate(
    { waId: m.waId },
    {
      $set: set,
      $inc: { noLeidos: m.direccion === 'entrante' ? 1 : 0 },
      $setOnInsert: { waId: m.waId, createdAt: new Date() },
    },
    { upsert: true, returnDocument: 'after' },
  );
  return completarCliente(conv);
}

/** Si el mensaje es el último de su conversación, refleja su nuevo estado en el resumen. */
async function actualizarResumen(m: WhatsAppMensaje): Promise<void> {
  await conversaciones().updateOne({ waId: m.waId, 'ultimoMensaje.id': m.id }, { $set: { ultimoMensaje: resumen(m) } });
}

// ---------------------------------------------------------------------------
// Webhook entrante
// ---------------------------------------------------------------------------

const TIPOS_MEDIA = ['image', 'video', 'audio', 'document', 'sticker'] as const;

interface MensajeMeta {
  from: string;
  to?: string;
  id: string;
  timestamp: string;
  type: string;
  context?: { id?: string };
  [k: string]: any;
}

/** Convierte un mensaje del webhook en los campos propios (tipo, texto, media, ubicación). */
function interpretar(msg: MensajeMeta): Pick<WhatsAppMensaje, 'tipo' | 'texto' | 'media' | 'ubicacion'> {
  const tipo = msg.type;
  if (tipo === 'text') return { tipo: 'text', texto: msg.text?.body || '' };

  if ((TIPOS_MEDIA as readonly string[]).includes(tipo)) {
    const m = msg[tipo] || {};
    return {
      tipo: tipo as WhatsAppTipoMensaje,
      texto: m.caption || undefined,
      media: {
        mimetype: m.mime_type || 'application/octet-stream',
        nombre: m.filename,
        estado: 'pendiente',
        metaMediaId: m.id,
      },
    };
  }

  if (tipo === 'location') {
    const l = msg.location || {};
    return {
      tipo: 'location',
      texto: [l.name, l.address].filter(Boolean).join(' · ') || undefined,
      ubicacion: { latitud: l.latitude, longitud: l.longitude, nombre: l.name, direccion: l.address },
    };
  }

  if (tipo === 'contacts') {
    const texto = (msg.contacts || [])
      .map((c: any) => [c.name?.formatted_name, ...(c.phones || []).map((p: any) => p.phone)].filter(Boolean).join(' '))
      .join('\n');
    return { tipo: 'contacts', texto };
  }

  // Respuestas a botones de plantillas y a mensajes interactivos: se muestran como texto.
  if (tipo === 'button') return { tipo: 'text', texto: msg.button?.text || '' };
  if (tipo === 'interactive') {
    const r = msg.interactive?.button_reply || msg.interactive?.list_reply;
    return { tipo: 'text', texto: r?.title || '' };
  }

  return { tipo: 'unsupported', texto: 'Mensaje no soportado (ábrelo en WhatsApp para verlo)' };
}

async function descargarAdjunto(io: Server | undefined, mensajeId: string, media: WhatsAppMedia): Promise<void> {
  let update: Partial<WhatsAppMensaje>;
  try {
    const { buffer, mimetype } = await descargarMedia(media.metaMediaId!);
    const archivo = guardarArchivo(buffer, mimetype, media.nombre);
    update = { media: { ...media, archivo, mimetype, size: buffer.length, estado: 'listo' } };
  } catch (error) {
    console.error('Error descargando adjunto de WhatsApp:', error);
    update = { media: { ...media, estado: 'error' } };
  }
  const actualizado = await mensajes().findOneAndUpdate(
    { id: mensajeId },
    { $set: { ...update, updatedAt: new Date() } },
    { returnDocument: 'after' },
  );
  if (actualizado) emitirMensaje(io, actualizado);
}

/** Reintenta la descarga de un adjunto entrante que falló (desde el panel). */
export async function reintentarDescarga(io: Server | undefined, mensajeId: string): Promise<boolean> {
  const m = await mensajes().findOne({ id: mensajeId });
  if (!m?.media?.metaMediaId || m.media.estado === 'listo') return false;
  await descargarAdjunto(io, m.id, m.media);
  return true;
}

async function guardarMensajeMeta(
  io: Server | undefined,
  msg: MensajeMeta,
  direccion: 'entrante' | 'saliente',
  nombrePerfil?: string,
): Promise<void> {
  const waId = direccion === 'entrante' ? msg.from : msg.to;
  if (!waId) return;

  if (msg.type === 'reaction') {
    const r = msg.reaction || {};
    const objetivo = await mensajes().findOneAndUpdate(
      { waMessageId: r.message_id },
      r.emoji ? { $set: { reaccion: r.emoji, updatedAt: new Date() } } : { $unset: { reaccion: '' }, $set: { updatedAt: new Date() } },
      { returnDocument: 'after' },
    );
    if (objetivo) emitirMensaje(io, objetivo);
    return;
  }

  const contenido = interpretar(msg);
  const citado = msg.context?.id ? await mensajes().findOne({ waMessageId: msg.context.id }) : null;
  const ahora = new Date();
  const nuevo: WhatsAppMensaje = {
    id: crypto.randomUUID(),
    waMessageId: msg.id,
    waId,
    direccion,
    ...contenido,
    estado: direccion === 'entrante' ? 'recibido' : 'enviado',
    ...(citado ? { cita: citaDe(citado) } : {}),
    fecha: msg.timestamp ? new Date(Number(msg.timestamp) * 1000) : ahora,
    createdAt: ahora,
    updatedAt: ahora,
  };

  try {
    await mensajes().insertOne(nuevo);
  } catch (error: any) {
    if (error?.code === 11000) return; // Meta reenvió un webhook ya procesado
    throw error;
  }

  const conv = await registrarEnConversacion(nuevo, nombrePerfil);
  emitirMensaje(io, nuevo, conv);

  // El binario se descarga aparte para responder rápido a Meta; al terminar se avisa por socket.
  if (nuevo.media?.metaMediaId) void descargarAdjunto(io, nuevo.id, nuevo.media);
}

const RANGO_ESTADO: Record<string, number> = { enviando: 0, enviado: 1, entregado: 2, leido: 3 };
const ESTADO_META: Record<string, WhatsAppEstadoMensaje> = {
  sent: 'enviado', delivered: 'entregado', read: 'leido', failed: 'fallido',
};

async function actualizarEstado(io: Server | undefined, status: any, reintento = false): Promise<void> {
  const estado = ESTADO_META[status.status];
  if (!estado || !status.id) return;

  // Los webhooks pueden llegar desordenados: nunca se retrocede (p. ej. 'entregado' después de 'leido').
  const previos = estado === 'fallido'
    ? ['enviando', 'enviado', 'entregado']
    : Object.keys(RANGO_ESTADO).filter((e) => RANGO_ESTADO[e] < RANGO_ESTADO[estado]);

  const set: Partial<WhatsAppMensaje> = { estado, updatedAt: new Date() };
  if (estado === 'fallido') {
    const e = status.errors?.[0];
    set.error = e?.code === 131047
      ? 'Pasaron más de 24 horas desde el último mensaje del cliente: solo se le puede escribir con una plantilla.'
      : e?.error_data?.details || e?.message || e?.title || 'WhatsApp no pudo entregar el mensaje';
  }

  const m = await mensajes().findOneAndUpdate(
    { waMessageId: status.id, estado: { $in: previos as WhatsAppEstadoMensaje[] } },
    { $set: set },
    { returnDocument: 'after' },
  );
  if (!m) {
    // Un estado de un mensaje recién enviado desde el panel puede llegar antes de que se
    // guarde su wamid (la respuesta de la API y el webhook viajan por caminos distintos).
    if (!reintento && !(await mensajes().findOne({ waMessageId: status.id }))) {
      setTimeout(() => actualizarEstado(io, status, true).catch(() => {}), 3000);
    }
    return;
  }
  await actualizarResumen(m);
  emitirMensaje(io, m);
}

/** Procesa el cuerpo completo de un webhook de WhatsApp (mensajes, estados y ecos del teléfono). */
export async function procesarWebhook(io: Server | undefined, body: any): Promise<void> {
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID?.trim();

  for (const entry of body?.entry || []) {
    for (const change of entry.changes || []) {
      const value = change.value || {};
      // Si la app de Meta tiene varios números, solo se procesa el configurado.
      if (phoneNumberId && value.metadata?.phone_number_id && value.metadata.phone_number_id !== phoneNumberId) continue;

      if (change.field === 'messages') {
        const nombres = new Map<string, string>();
        for (const c of value.contacts || []) if (c.wa_id && c.profile?.name) nombres.set(c.wa_id, c.profile.name);

        for (const msg of value.messages || []) {
          try {
            await guardarMensajeMeta(io, msg, 'entrante', nombres.get(msg.from));
          } catch (error) {
            console.error('Error guardando mensaje de WhatsApp:', error);
          }
        }
        for (const status of value.statuses || []) {
          try {
            await actualizarEstado(io, status);
          } catch (error) {
            console.error('Error actualizando estado de WhatsApp:', error);
          }
        }
      }

      // Mensajes escritos desde la app WhatsApp Business del teléfono (coexistencia).
      if (change.field === 'smb_message_echoes') {
        for (const msg of value.message_echoes || []) {
          try {
            await guardarMensajeMeta(io, msg, 'saliente');
          } catch (error) {
            console.error('Error guardando eco de WhatsApp:', error);
          }
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Envío desde el panel
// ---------------------------------------------------------------------------

export interface Operador {
  userId: string;
  nombre: string;
}

export interface EnvioMedia {
  buffer: Buffer;
  mimetype: string;
  nombre: string;
}

/**
 * Decide cómo mandar un archivo según los límites de WhatsApp: imágenes JPG/PNG hasta
 * 5 MB, video MP4/3GP y audio hasta 16 MB; todo lo demás va como documento (100 MB).
 */
export function tipoParaEnvio(mimetype: string, size: number): TipoMediaSaliente {
  const mime = mimeBase(mimetype);
  const MB = 1024 * 1024;
  if (['image/jpeg', 'image/png'].includes(mime) && size <= 5 * MB) return 'image';
  if (['video/mp4', 'video/3gpp'].includes(mime) && size <= 16 * MB) return 'video';
  if (['audio/aac', 'audio/amr', 'audio/mpeg', 'audio/mp4', 'audio/ogg'].includes(mime) && size <= 16 * MB) return 'audio';
  return 'document';
}

/**
 * Guarda el mensaje como 'enviando' y lo publica al instante (el panel lo pinta ya),
 * lo manda a WhatsApp y luego publica el resultado: 'enviado' con su wamid, o
 * 'fallido' con el motivo. Los siguientes estados (entregado, leído) llegan por webhook.
 */
export async function enviarDesdePanel(
  io: Server | undefined,
  waId: string,
  operador: Operador,
  contenido: { texto?: string; media?: EnvioMedia; citaId?: string },
): Promise<WhatsAppMensaje> {
  const conv = await conversaciones().findOne({ waId });
  if (!conv) throw new WhatsAppApiError('Conversación no encontrada', undefined, 404);

  const citado = contenido.citaId ? await mensajes().findOne({ id: contenido.citaId, waId }) : null;
  const texto = contenido.texto?.trim() || undefined;
  const ahora = new Date();

  let tipoMedia: TipoMediaSaliente | undefined;
  let media: WhatsAppMedia | undefined;
  if (contenido.media) {
    const { buffer, mimetype, nombre } = contenido.media;
    tipoMedia = tipoParaEnvio(mimetype, buffer.length);
    media = { archivo: guardarArchivo(buffer, mimetype, nombre), mimetype: mimeBase(mimetype), nombre, size: buffer.length, estado: 'listo' };
  }

  const mensaje: WhatsAppMensaje = {
    id: crypto.randomUUID(),
    waId,
    direccion: 'saliente',
    tipo: tipoMedia ?? 'text',
    texto,
    ...(media ? { media } : {}),
    estado: 'enviando',
    ...(citado ? { cita: citaDe(citado) } : {}),
    enviadoPor: operador,
    fecha: ahora,
    createdAt: ahora,
    updatedAt: ahora,
  };
  await mensajes().insertOne(mensaje);
  emitirMensaje(io, mensaje, await registrarEnConversacion(mensaje));

  let set: Partial<WhatsAppMensaje>;
  try {
    const citaWamid = citado?.waMessageId;
    let wamid: string;
    if (contenido.media && tipoMedia) {
      const mediaId = await subirMedia(contenido.media.buffer, mimeBase(contenido.media.mimetype), contenido.media.nombre);
      wamid = await enviarMedia(waId, tipoMedia, mediaId, { caption: texto, filename: contenido.media.nombre, citaWamid });
    } else {
      wamid = await enviarTexto(waId, texto || '', citaWamid);
    }
    set = { waMessageId: wamid, estado: 'enviado', updatedAt: new Date() };
  } catch (error) {
    console.error('Error enviando mensaje de WhatsApp:', error);
    set = { estado: 'fallido', error: error instanceof Error ? error.message : 'Error al enviar', updatedAt: new Date() };
  }

  const final = await mensajes().findOneAndUpdate({ id: mensaje.id }, { $set: set }, { returnDocument: 'after' });
  if (final) {
    await actualizarResumen(final);
    emitirMensaje(io, final);
  }
  return final || mensaje;
}

/** Reenvía un mensaje que falló (crea uno nuevo y borra el fallido). */
export async function reintentarEnvio(io: Server | undefined, mensajeId: string, operador: Operador): Promise<WhatsAppMensaje | null> {
  const m = await mensajes().findOne({ id: mensajeId, direccion: 'saliente', estado: 'fallido' });
  if (!m) return null;

  let media: EnvioMedia | undefined;
  if (m.media?.archivo) {
    const ruta = rutaArchivo(m.media.archivo);
    if (!ruta || !fs.existsSync(ruta)) return null;
    media = { buffer: fs.readFileSync(ruta), mimetype: m.media.mimetype, nombre: m.media.nombre || path.basename(ruta) };
  }
  await mensajes().deleteOne({ id: m.id });
  io?.to(SALA).emit('wa:mensaje-eliminado', { id: m.id, waId: m.waId });
  return enviarDesdePanel(io, m.waId, operador, { texto: m.texto, media, citaId: m.cita?.id });
}

/** Pone en cero los no leídos y envía a WhatsApp la confirmación de lectura del último mensaje del cliente. */
export async function marcarConversacionLeida(io: Server | undefined, waId: string): Promise<WhatsAppConversacion | null> {
  const conv = await conversaciones().findOneAndUpdate({ waId }, { $set: { noLeidos: 0 } }, { returnDocument: 'after' });
  if (!conv) return null;
  emitirConversacion(io, conv);

  const ultimoEntrante = await mensajes().findOne(
    { waId, direccion: 'entrante', waMessageId: { $exists: true } },
    { sort: { fecha: -1 } },
  );
  if (ultimoEntrante?.waMessageId) {
    marcarLeido(ultimoEntrante.waMessageId).catch((error) =>
      console.error('Error marcando como leído en WhatsApp:', error instanceof Error ? error.message : error),
    );
  }
  return conv;
}

export async function renombrarConversacion(io: Server | undefined, waId: string, alias: string): Promise<WhatsAppConversacion | null> {
  const limpio = alias.trim().slice(0, 80);
  const conv = await conversaciones().findOneAndUpdate(
    { waId },
    limpio ? { $set: { alias: limpio } } : { $unset: { alias: '' } },
    { returnDocument: 'after' },
  );
  if (conv) emitirConversacion(io, conv);
  return conv;
}

export { conversaciones as coleccionConversaciones, mensajes as coleccionMensajes, limpiar };
