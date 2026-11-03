import crypto from 'crypto';
import { emitirAUsuarios } from './autorizaciones-socket.service';
import { ErrorAutorizaciones } from './autorizaciones-vinculos.service';

/**
 * Consultas que un admin hace desde el celular y que solo puede contestar la tienda (el
 * celular no llega a su red local): precio y existencia de un producto, y mensajes a una
 * sesión abierta de sellhub. El celular la deja aquí (POST /movil/consultas); las PCs de
 * la tienda con sesión abierta preguntan cada pocos segundos (GET /caja/consultas) y la
 * primera que la pide se la lleva y contesta (POST /caja/consultas/:id/respuesta).
 *
 * Viven solo en memoria: duran segundos.
 */
type TipoConsulta = 'producto' | 'mensaje';

interface Consulta {
  id: string;
  tipo: TipoConsulta;
  datos: Record<string, string>;
  usuarioId: string;
  usuarioNombre: string;
  estado: 'pendiente' | 'tomada' | 'respondida' | 'fallida';
  creadaEn: number;
  tomadaEn: number | null;
  resultado: unknown;
  mensaje: string | null;
}

const VIDA_MS = 30_000;
/** Si la PC que la tomó no contesta en este tiempo, otra la puede tomar. */
const REINTENTO_MS = 8_000;
const MAX_POR_USUARIO = 5;

const consultas = new Map<string, Consulta>();

function limpiar(): void {
  const limite = Date.now() - VIDA_MS;
  for (const [id, c] of consultas) if (c.creadaEn < limite) consultas.delete(id);
}

const texto = (v: unknown, max: number): string => (typeof v === 'string' ? v.trim().slice(0, max) : '');

export function crearConsulta(usuarioId: string, usuarioNombre: string, input: Record<string, unknown>): { id: string } {
  limpiar();
  const tipo = input.tipo === 'producto' || input.tipo === 'mensaje' ? input.tipo : null;
  if (!tipo) throw new ErrorAutorizaciones(400, 'Tipo de consulta desconocido');
  const d = (input.datos && typeof input.datos === 'object' ? input.datos : {}) as Record<string, unknown>;
  const datos: Record<string, string> =
    tipo === 'producto'
      ? { termino: texto(d.termino, 100) }
      : { sesionId: texto(d.sesionId, 64), mensaje: texto(d.mensaje, 1000) };
  if (tipo === 'producto' && !datos.termino) throw new ErrorAutorizaciones(400, 'Escribe o escanea un código');
  if (tipo === 'mensaje' && (!datos.sesionId || !datos.mensaje)) throw new ErrorAutorizaciones(400, 'Falta el mensaje o a quién');
  const abiertas = [...consultas.values()].filter((c) => c.usuarioId === usuarioId && (c.estado === 'pendiente' || c.estado === 'tomada'));
  if (abiertas.length >= MAX_POR_USUARIO) throw new ErrorAutorizaciones(429, 'Espera a que terminen tus consultas anteriores');

  const c: Consulta = {
    id: crypto.randomUUID(),
    tipo,
    datos,
    usuarioId,
    usuarioNombre,
    estado: 'pendiente',
    creadaEn: Date.now(),
    tomadaEn: null,
    resultado: null,
    mensaje: null,
  };
  consultas.set(c.id, c);
  return { id: c.id };
}

/** Lo que ve el celular de su consulta. */
export function consultaPara(usuarioId: string, id: string) {
  limpiar();
  const c = consultas.get(id);
  if (!c || c.usuarioId !== usuarioId) {
    return { estado: 'expirada', resultado: null, mensaje: 'Ninguna PC de la tienda respondió. ¿Está abierto EscolaresPRO?' };
  }
  return { estado: c.estado, resultado: c.resultado, mensaje: c.mensaje };
}

/** La PC que pregunta se lleva las pendientes (y las que otra tomó y no contestó). */
export function tomarConsultas() {
  limpiar();
  const ahora = Date.now();
  const tomadas: Consulta[] = [];
  for (const c of consultas.values()) {
    const libre = c.estado === 'pendiente' || (c.estado === 'tomada' && c.tomadaEn !== null && ahora - c.tomadaEn > REINTENTO_MS);
    if (!libre) continue;
    c.estado = 'tomada';
    c.tomadaEn = ahora;
    tomadas.push(c);
    if (tomadas.length >= 20) break;
  }
  return tomadas.map((c) => ({ id: c.id, tipo: c.tipo, datos: c.datos, usuarioId: c.usuarioId, usuarioNombre: c.usuarioNombre }));
}

export function responderConsulta(id: string, input: Record<string, unknown>): void {
  const c = consultas.get(id);
  if (!c || c.estado === 'respondida' || c.estado === 'fallida') return;
  const resultado = input.resultado ?? null;
  if (Buffer.byteLength(JSON.stringify(resultado)) > 256 * 1024) throw new ErrorAutorizaciones(413, 'Respuesta demasiado grande');
  c.estado = input.ok === true ? 'respondida' : 'fallida';
  c.resultado = resultado;
  c.mensaje = texto(input.mensaje, 300) || null;
  emitirAUsuarios([c.usuarioId], 'consulta', { id: c.id, estado: c.estado, resultado: c.resultado, mensaje: c.mensaje });
}
