import crypto from 'crypto';

/**
 * Cliente mínimo de la WhatsApp Cloud API (Graph API de Meta) para el módulo
 * Empresas > WhatsApp. Las credenciales vienen de variables de entorno
 * (WHATSAPP_TOKEN, WHATSAPP_PHONE_NUMBER_ID), nunca de la base de datos.
 */

const GRAPH_VERSION = process.env.WHATSAPP_API_VERSION || 'v25.0';
const GRAPH_URL = `https://graph.facebook.com/${GRAPH_VERSION}`;

export class WhatsAppApiError extends Error {
  constructor(message: string, public code?: number, public status?: number) {
    super(message);
  }
}

function credenciales(): { token: string; phoneNumberId: string } {
  const token = process.env.WHATSAPP_TOKEN?.trim();
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID?.trim();
  if (!token || !phoneNumberId) {
    throw new WhatsAppApiError('WhatsApp no está configurado (faltan WHATSAPP_TOKEN / WHATSAPP_PHONE_NUMBER_ID)');
  }
  return { token, phoneNumberId };
}

export function whatsappConfigurado(): boolean {
  return !!process.env.WHATSAPP_TOKEN?.trim() && !!process.env.WHATSAPP_PHONE_NUMBER_ID?.trim();
}

/** Traduce los códigos de error de Meta más comunes a un mensaje entendible para el operador. */
function mensajeError(code: number | undefined, original: string): string {
  switch (code) {
    case 131047:
      return 'Pasaron más de 24 horas desde el último mensaje del cliente: WhatsApp solo permite escribirle con una plantilla aprobada.';
    case 131026:
      return 'El mensaje no se pudo entregar: el número no tiene WhatsApp o no acepta mensajes.';
    case 131051:
      return 'Tipo de mensaje no soportado por WhatsApp.';
    case 131052:
    case 131053:
      return 'WhatsApp no pudo procesar el archivo adjunto (formato o tamaño no válido).';
    case 190:
      return 'El token de WhatsApp expiró o es inválido. Genera uno nuevo en Meta y actualiza WHATSAPP_TOKEN.';
    case 100:
      return `Parámetro inválido en la solicitud a WhatsApp: ${original}`;
    default:
      return original;
  }
}

async function graphFetch<T>(pathOrUrl: string, init: RequestInit = {}): Promise<T> {
  const { token } = credenciales();
  const url = pathOrUrl.startsWith('http') ? pathOrUrl : `${GRAPH_URL}/${pathOrUrl}`;
  const response = await fetch(url, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, ...(init.headers || {}) },
  });
  const texto = await response.text();
  let json: any = null;
  try { json = texto ? JSON.parse(texto) : null; } catch { /* respuesta no JSON */ }

  if (!response.ok) {
    const err = json?.error;
    const code = err?.code !== undefined ? Number(err.code) : undefined;
    const detalle = err?.error_data?.details || err?.message || texto || `HTTP ${response.status}`;
    throw new WhatsAppApiError(mensajeError(code, detalle), code, response.status);
  }
  return json as T;
}

interface EnvioRespuesta {
  messages?: { id: string }[];
}

async function enviar(payload: Record<string, unknown>): Promise<string> {
  const { phoneNumberId } = credenciales();
  const res = await graphFetch<EnvioRespuesta>(`${phoneNumberId}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ messaging_product: 'whatsapp', recipient_type: 'individual', ...payload }),
  });
  const wamid = res.messages?.[0]?.id;
  if (!wamid) throw new WhatsAppApiError('WhatsApp no devolvió el id del mensaje enviado');
  return wamid;
}

function contexto(citaWamid?: string) {
  return citaWamid ? { context: { message_id: citaWamid } } : {};
}

export async function enviarTexto(to: string, body: string, citaWamid?: string): Promise<string> {
  return enviar({
    to,
    type: 'text',
    text: { body, preview_url: /https?:\/\/\S+/i.test(body) },
    ...contexto(citaWamid),
  });
}

export type TipoMediaSaliente = 'image' | 'video' | 'audio' | 'document';

export async function enviarMedia(
  to: string,
  tipo: TipoMediaSaliente,
  mediaId: string,
  opciones: { caption?: string; filename?: string; citaWamid?: string } = {},
): Promise<string> {
  const media: Record<string, string> = { id: mediaId };
  // WhatsApp no admite caption en audios.
  if (opciones.caption && tipo !== 'audio') media.caption = opciones.caption;
  if (opciones.filename && tipo === 'document') media.filename = opciones.filename;
  return enviar({ to, type: tipo, [tipo]: media, ...contexto(opciones.citaWamid) });
}

/** Sube un archivo a Meta y devuelve su media id, para enviarlo después con enviarMedia. */
export async function subirMedia(buffer: Buffer, mimetype: string, nombre: string): Promise<string> {
  const { phoneNumberId } = credenciales();
  const form = new FormData();
  form.append('messaging_product', 'whatsapp');
  form.append('type', mimetype);
  form.append('file', new Blob([new Uint8Array(buffer)], { type: mimetype }), nombre);
  const res = await graphFetch<{ id: string }>(`${phoneNumberId}/media`, { method: 'POST', body: form });
  return res.id;
}

/** Descarga un adjunto recibido: primero se pide su URL temporal y luego el binario (ambos con el token). */
export async function descargarMedia(mediaId: string): Promise<{ buffer: Buffer; mimetype: string }> {
  const info = await graphFetch<{ url: string; mime_type: string }>(mediaId);
  const { token } = credenciales();
  const response = await fetch(info.url, { headers: { Authorization: `Bearer ${token}` } });
  if (!response.ok) throw new WhatsAppApiError(`No se pudo descargar el adjunto (HTTP ${response.status})`);
  const buffer = Buffer.from(await response.arrayBuffer());
  return { buffer, mimetype: info.mime_type };
}

/** Marca como leído (doble check azul para el cliente) un mensaje entrante y todos los anteriores. */
export async function marcarLeido(wamid: string): Promise<void> {
  const { phoneNumberId } = credenciales();
  await graphFetch(`${phoneNumberId}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ messaging_product: 'whatsapp', status: 'read', message_id: wamid }),
  });
}

/**
 * Valida la cabecera X-Hub-Signature-256 del webhook con el App Secret de la app de Meta.
 * Si WHATSAPP_APP_SECRET no está configurado no se valida (compatibilidad con la
 * instalación actual), pero se recomienda configurarlo.
 */
export function firmaWebhookValida(rawBody: Buffer | undefined, firma: string | undefined): boolean {
  const secret = process.env.WHATSAPP_APP_SECRET?.trim();
  if (!secret) return true;
  if (!rawBody || !firma?.startsWith('sha256=')) return false;
  const esperada = Buffer.from(`sha256=${crypto.createHmac('sha256', secret).update(rawBody).digest('hex')}`);
  const recibida = Buffer.from(firma);
  return esperada.length === recibida.length && crypto.timingSafeEqual(esperada, recibida);
}

let numeroCache: { numero: string; nombre: string } | null = null;

/** Número y nombre verificado de la cuenta (para mostrarlos en el panel). Se consulta una sola vez. */
export async function obtenerNumero(): Promise<{ numero: string; nombre: string } | null> {
  if (numeroCache) return numeroCache;
  try {
    const { phoneNumberId } = credenciales();
    const r = await graphFetch<{ display_phone_number: string; verified_name: string }>(
      `${phoneNumberId}?fields=display_phone_number,verified_name`,
    );
    numeroCache = { numero: r.display_phone_number, nombre: r.verified_name };
    return numeroCache;
  } catch (error) {
    console.error('Error consultando el número de WhatsApp:', error instanceof Error ? error.message : error);
    return null;
  }
}
