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
type TipoConsulta = 'producto' | 'mensaje' | 'factura' | 'facturas' | 'ticket' | 'resumen';

const TIPOS: TipoConsulta[] = ['producto', 'mensaje', 'factura', 'facturas', 'ticket', 'resumen'];
/** Lo que entienden las PCs con versiones de sellhub que todavía no dicen qué tipos atienden. */
const TIPOS_VERSION_VIEJA: TipoConsulta[] = ['producto', 'mensaje'];
const FECHA = /^\d{4}-\d{2}-\d{2}$/;
const fecha = (v: unknown): string => (typeof v === 'string' && FECHA.test(v.trim()) ? v.trim() : '');

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

/**
 * PCs de la tienda que están preguntando por consultas (cada 2,5 s mientras tengan sesión
 * abierta), con los tipos que saben contestar. Así el celular ve quién atiende y, si nadie
 * puede contestar, se le dice al instante en vez de esperar 25 segundos.
 */
const VIGENCIA_PC_MS = 15_000;
const pcs = new Map<string, { visto: number; tipos: TipoConsulta[] }>();

function pcsActivas() {
  const limite = Date.now() - VIGENCIA_PC_MS;
  for (const [equipo, pc] of pcs) if (pc.visto < limite) pcs.delete(equipo);
  return [...pcs.entries()].map(([equipo, pc]) => ({ equipo, ...pc }));
}

/** Para la app: qué PCs están atendiendo y si tienen la versión que contesta todo. */
export function estadoTienda() {
  const ahora = Date.now();
  return {
    pcs: pcsActivas()
      .map((pc) => ({
        equipo: pc.equipo,
        segundos: Math.round((ahora - pc.visto) / 1000),
        actualizada: TIPOS.every((t) => pc.tipos.includes(t)),
      }))
      .sort((a, b) => a.equipo.localeCompare(b.equipo)),
  };
}

function limpiar(): void {
  const limite = Date.now() - VIDA_MS;
  for (const [id, c] of consultas) if (c.creadaEn < limite) consultas.delete(id);
}

const texto = (v: unknown, max: number): string => (typeof v === 'string' ? v.trim().slice(0, max) : '');

export function crearConsulta(usuarioId: string, usuarioNombre: string, input: Record<string, unknown>): { id: string } {
  limpiar();
  const tipo = TIPOS.includes(input.tipo as TipoConsulta) ? (input.tipo as TipoConsulta) : null;
  if (!tipo) throw new ErrorAutorizaciones(400, 'Tipo de consulta desconocido');
  const d = (input.datos && typeof input.datos === 'object' ? input.datos : {}) as Record<string, unknown>;
  let datos: Record<string, string>;
  switch (tipo) {
    case 'producto':
      datos = { termino: texto(d.termino, 100) };
      if (!datos.termino) throw new ErrorAutorizaciones(400, 'Escribe o escanea un código');
      break;
    case 'factura':
      datos = { termino: texto(d.termino, 60), numero: texto(d.numero, 60) };
      if (!datos.termino && !datos.numero) throw new ErrorAutorizaciones(400, 'Escribe el número de factura, el cliente o la cédula');
      break;
    case 'facturas':
      datos = {
        desde: fecha(d.desde),
        hasta: fecha(d.hasta),
        termino: texto(d.termino, 60),
        pagina: String(Math.max(0, Math.min(1000, Math.floor(Number(d.pagina) || 0)))),
      };
      break;
    case 'ticket':
      datos = { numero: texto(d.numero, 60) };
      if (!datos.numero) throw new ErrorAutorizaciones(400, 'Falta el número de factura');
      break;
    case 'resumen':
      datos = { fecha: fecha(d.fecha) };
      if (!datos.fecha) throw new ErrorAutorizaciones(400, 'Escoge un día');
      break;
    default:
      datos = { sesionId: texto(d.sesionId, 64), mensaje: texto(d.mensaje, 1000) };
      if (!datos.sesionId || !datos.mensaje) throw new ErrorAutorizaciones(400, 'Falta el mensaje o a quién');
  }
  const activas = pcsActivas();
  if (!activas.some((pc) => pc.tipos.includes(tipo))) {
    throw new ErrorAutorizaciones(
      503,
      activas.length
        ? 'Las PCs abiertas tienen una versión vieja de EscolaresPRO: actualízalas para usar esta función.'
        : 'Ninguna PC de la tienda tiene EscolaresPRO abierto con sesión iniciada.',
    );
  }
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

/**
 * La PC que pregunta se lleva las pendientes (y las que otra tomó y no contestó), solo de
 * los tipos que dice atender (`tipos`, separados por coma). Sin `tipos` es una versión
 * vieja de sellhub: solo producto y mensaje.
 */
export function tomarConsultas(tiposTexto?: unknown, equipoTexto?: unknown) {
  limpiar();
  const pedidos = typeof tiposTexto === 'string' ? tiposTexto.split(',').map((t) => t.trim()) : [];
  const atiende = pedidos.length ? TIPOS.filter((t) => pedidos.includes(t)) : TIPOS_VERSION_VIEJA;
  const equipo = texto(equipoTexto, 80) || (pedidos.length ? 'PC sin nombre' : 'PC sin actualizar');
  pcs.set(equipo, { visto: Date.now(), tipos: atiende });
  const ahora = Date.now();
  const tomadas: Consulta[] = [];
  for (const c of consultas.values()) {
    if (!atiende.includes(c.tipo)) continue;
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
  // La imagen de la factura es el HTML del ticket con el logo incrustado: puede pesar más.
  const limite = c.tipo === 'ticket' ? 6 * 1024 * 1024 : 512 * 1024;
  if (Buffer.byteLength(JSON.stringify(resultado)) > limite) throw new ErrorAutorizaciones(413, 'Respuesta demasiado grande');
  c.estado = input.ok === true ? 'respondida' : 'fallida';
  c.resultado = resultado;
  c.mensaje = texto(input.mensaje, 300) || null;
  emitirAUsuarios([c.usuarioId], 'consulta', { id: c.id, estado: c.estado, resultado: c.resultado, mensaje: c.mensaje });
}
