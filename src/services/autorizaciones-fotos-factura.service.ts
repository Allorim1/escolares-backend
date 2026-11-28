import crypto from 'crypto';
import { emitirADispositivo } from './autorizaciones-socket.service';
import { ErrorAutorizaciones, VinculoAutorizaciones } from './autorizaciones-vinculos.service';
import { nombreTienda, prefijoTienda } from './autorizaciones-tiendas.service';
import { enviarPushATokens } from './push.service';

/**
 * Fotos de facturas tomadas con la cámara de un celular vinculado (app de supervisores).
 *
 * La caja de sellhub elige un celular de Seguridad → Celulares y pide una foto indicando
 * proveedor y número. El relay avisa a ESE dispositivo por socket y por push; la APK abre la
 * cámara y sube el JPEG. La caja sondea el estado, descarga la imagen y la deja en la bandeja,
 * desde donde se asocia igual que un escaneo WIA o un archivo elegido a mano.
 *
 * La imagen vive solo en memoria mientras la caja la recoge; se desecha a los pocos minutos.
 * Nunca se mezcla con las solicitudes de PIN ni con el historial de autorizaciones.
 */
export type EstadoFotoFactura = 'pendiente' | 'enviada' | 'rechazada' | 'cancelada' | 'expirada';

/** Aviso que recibe la app (socket, push o al conectar). */
export interface FotoFacturaPedida {
  id: string;
  proveedor: string;
  numeroFactura: string;
  solicitante: string;
  tiendaNombre?: string;
  expiraEn?: string;
}

interface PedidoFotoFactura {
  id: string;
  tiendaId: string;
  /** Id interno (`tienda:usuario`) del usuario de sellhub dueño del celular. */
  destinatario: string;
  escolaresUserId: string;
  dispositivoId: string;
  celularNombre: string;
  proveedor: string;
  numeroFactura: string;
  solicitante: string;
  estado: EstadoFotoFactura;
  foto: Buffer | null;
  nombreArchivo: string | null;
  bytes: number;
  mensaje: string | null;
  creadaEn: number;
  expiraEn: number;
  resueltaEn: number | null;
}

/** Tiempo para que el supervisor tome la foto. */
const ESPERA_MS = 10 * 60_000;
/** La imagen se conserva un rato para que la caja pueda descargarla. */
const RETENER_MS = 15 * 60_000;
export const MAX_FOTO_FACTURA_BYTES = 20 * 1024 * 1024;

const pedidos = new Map<string, PedidoFotoFactura>();
const abierta = (p: PedidoFotoFactura) => p.estado === 'pendiente';

function obtener(id: string): PedidoFotoFactura {
  const pedido = pedidos.get(id);
  if (!pedido) throw new ErrorAutorizaciones(404, 'Esa solicitud de foto ya no existe');
  return pedido;
}

function obtenerDeTienda(tiendaId: string, id: string): PedidoFotoFactura {
  const pedido = obtener(id);
  if (pedido.tiendaId !== tiendaId) throw new ErrorAutorizaciones(404, 'Esa solicitud de foto ya no existe');
  return pedido;
}

const texto = (valor: unknown, max: number) => (typeof valor === 'string' && valor.trim() ? valor.trim().slice(0, max) : '');

function cerrar(p: PedidoFotoFactura, estado: EstadoFotoFactura, mensaje: string, foto: Buffer | null = null): void {
  if (!abierta(p)) return;
  p.estado = estado;
  p.mensaje = mensaje;
  p.foto = foto;
  p.bytes = foto?.length ?? 0;
  p.resueltaEn = Date.now();
  if (estado === 'enviada') {
    p.nombreArchivo = `Foto-${p.numeroFactura || 'factura'}-${new Date(p.resueltaEn).toISOString().replace(/[:.]/g, '-')}.jpg`;
  }
}

function avisarCancelada(p: PedidoFotoFactura, mensaje: string): void {
  emitirADispositivo(p.escolaresUserId, p.dispositivoId, 'foto:cancelada', { id: p.id, mensaje });
}

// ---------------------------------------------------------------- caja (sellhub)

/** Pide la foto al celular vinculado que eligió la caja. */
export async function pedirFotoFactura(
  tiendaId: string,
  vinculo: VinculoAutorizaciones,
  datos: Record<string, unknown>,
): Promise<{ id: string; expiraEn: string; celularNombre: string }> {
  if (vinculo.tiendaId !== tiendaId) throw new ErrorAutorizaciones(404, 'Ese celular no pertenece a esta tienda');
  const proveedor = texto(datos.proveedor, 150) || 'Proveedor';
  const numeroFactura = texto(datos.numeroFactura, 100);
  if (!numeroFactura) throw new ErrorAutorizaciones(400, 'Falta el número de factura');

  // Una caja no deja varias cámaras abiertas para la misma factura.
  for (const p of pedidos.values()) {
    if (p.tiendaId === tiendaId && p.destinatario === vinculo._id && abierta(p)) {
      cerrar(p, 'cancelada', 'Se pidió otra foto');
      avisarCancelada(p, 'Se pidió otra foto desde la caja');
    }
  }

  const ahora = Date.now();
  const p: PedidoFotoFactura = {
    id: crypto.randomUUID(),
    tiendaId,
    destinatario: vinculo._id,
    escolaresUserId: vinculo.escolaresUserId,
    dispositivoId: vinculo.dispositivoId,
    celularNombre: vinculo.dispositivoNombre,
    proveedor,
    numeroFactura,
    solicitante: texto(datos.solicitante, 150) || 'La caja',
    estado: 'pendiente',
    foto: null,
    nombreArchivo: null,
    bytes: 0,
    mensaje: null,
    creadaEn: ahora,
    expiraEn: ahora + ESPERA_MS,
    resueltaEn: null,
  };
  pedidos.set(p.id, p);

  const aviso = {
    id: p.id,
    proveedor: p.proveedor,
    numeroFactura: p.numeroFactura,
    solicitante: p.solicitante,
    tiendaNombre: nombreTienda(tiendaId),
    expiraEn: new Date(p.expiraEn).toISOString(),
  };
  emitirADispositivo(p.escolaresUserId, p.dispositivoId, 'foto:pedida', aviso);

  const tokens = [...new Set([...(vinculo.pushTokens ?? []), ...(vinculo.pushNativos ?? [])])];
  if (tokens.length) {
    void enviarPushATokens(
      tokens,
      {
        title: `📷 Foto de factura · ${prefijoTienda(tiendaId)}${p.proveedor}`,
        body: `Factura ${p.numeroFactura}. Toca para abrir la cámara.`,
        data: {
          tipo: 'foto_factura',
          fotoId: p.id,
          tiendaId,
          proveedor: p.proveedor,
          numeroFactura: p.numeroFactura,
          solicitante: p.solicitante,
          tiendaNombre: nombreTienda(tiendaId),
        },
      },
      'autorizaciones',
    ).catch((error: unknown) => console.error('Foto de factura: no se pudo enviar el push:', error));
  }

  return { id: p.id, expiraEn: new Date(p.expiraEn).toISOString(), celularNombre: p.celularNombre };
}

/** Lo que ve la caja mientras espera. */
export function estadoFotoFactura(tiendaId: string, id: string) {
  const p = obtenerDeTienda(tiendaId, id);
  return {
    id: p.id,
    estado: p.estado,
    mensaje: p.mensaje,
    proveedor: p.proveedor,
    numeroFactura: p.numeroFactura,
    celularNombre: p.celularNombre,
    nombreArchivo: p.nombreArchivo,
    bytes: p.bytes,
    creadaEn: new Date(p.creadaEn).toISOString(),
    expiraEn: new Date(p.expiraEn).toISOString(),
    resueltaEn: p.resueltaEn ? new Date(p.resueltaEn).toISOString() : null,
  };
}

/** La caja recoge el JPEG (raw, para no convertirlo en base64). */
export function archivoFotoFactura(tiendaId: string, id: string): Buffer {
  const p = obtenerDeTienda(tiendaId, id);
  if (!p.foto || p.estado !== 'enviada') throw new ErrorAutorizaciones(409, 'El celular todavía no envió la foto');
  return p.foto;
}

export function cancelarFotoFactura(tiendaId: string, id: string): void {
  const p = obtenerDeTienda(tiendaId, id);
  if (!abierta(p)) return;
  cerrar(p, 'cancelada', 'La caja canceló la solicitud');
  avisarCancelada(p, 'La caja canceló la solicitud');
}

// ---------------------------------------------------------------- celular

/**
 * Solo el celular al que se le pidió puede enviar la foto. `usuarios` son los vínculos de su
 * cuenta (para celulares secundarios); el dispositivo tiene que ser el elegido por la caja.
 */
function delCelular(id: string, usuarios: string[], escolaresUserId: string, dispositivoId: string): PedidoFotoFactura {
  const p = obtener(id);
  if (!usuarios.includes(p.destinatario) || p.escolaresUserId !== escolaresUserId || p.dispositivoId !== dispositivoId) {
    throw new ErrorAutorizaciones(404, 'No tienes una solicitud de foto abierta');
  }
  if (!abierta(p)) throw new ErrorAutorizaciones(409, `La solicitud ya está ${p.estado}`);
  return p;
}

/**
 * Fotos pendientes para ESTE celular. Se llama al conectar el socket: si el push no llegó
 * (app cerrada, FCM sin permiso, reconexión), la app igual muestra la cámara.
 */
export function fotosFacturaPendientes(usuarios: string[], dispositivoId: string): FotoFacturaPedida[] {
  const ahora = Date.now();
  return [...pedidos.values()]
    .filter((p) => abierta(p) && p.expiraEn > ahora && usuarios.includes(p.destinatario) && p.dispositivoId === dispositivoId)
    .map((p) => ({
      id: p.id,
      proveedor: p.proveedor,
      numeroFactura: p.numeroFactura,
      solicitante: p.solicitante,
      tiendaNombre: nombreTienda(p.tiendaId),
      expiraEn: new Date(p.expiraEn).toISOString(),
    }));
}

export function recibirFotoFactura(
  id: string,
  usuarios: string[],
  escolaresUserId: string,
  dispositivoId: string,
  foto: Buffer,
): void {
  const p = delCelular(id, usuarios, escolaresUserId, dispositivoId);
  if (!foto.length || foto.length > MAX_FOTO_FACTURA_BYTES) {
    throw new ErrorAutorizaciones(413, 'La foto está vacía o es demasiado grande (máximo 20 MB)');
  }
  cerrar(p, 'enviada', 'Foto recibida', foto);
}

export function rechazarFotoFactura(
  id: string,
  usuarios: string[],
  escolaresUserId: string,
  dispositivoId: string,
  motivo?: unknown,
): void {
  const p = delCelular(id, usuarios, escolaresUserId, dispositivoId);
  cerrar(p, 'rechazada', texto(motivo, 150) || 'No se tomó la foto');
}

// ---------------------------------------------------------------- limpieza

export function iniciarLimpiezaFotosFactura(): void {
  setInterval(() => {
    const ahora = Date.now();
    for (const p of pedidos.values()) {
      if (abierta(p) && ahora > p.expiraEn) {
        cerrar(p, 'expirada', 'Se venció el tiempo para tomar la foto');
        avisarCancelada(p, 'Se venció el tiempo para tomar la foto');
      } else if (!abierta(p) && p.resueltaEn && ahora - p.resueltaEn > RETENER_MS) {
        pedidos.delete(p.id);
      }
    }
  }, 4000);
}
