import crypto from 'crypto';
import { ErrorAutorizaciones } from './autorizaciones-vinculos.service';
import { emitirADispositivo } from './autorizaciones-socket.service';

/**
 * "Ver pantalla" desde la app de supervisores (solo root de la tienda), como Seguridad →
 * Control → Ver pantalla de EscolaresPRO, pero por internet: el celular no llega a la red
 * de la tienda, así que este backend hace de relevo.
 *
 *  - PC: su EscolaresPRO pregunta cada pocos segundos si alguien quiere ver SU sesión
 *    (GET /caja/pantallas?sesion=) y, mientras sí, sube una foto por segundo
 *    (POST /caja/pantallas/:id/frame). A la persona se le avisa que la están viendo.
 *  - Celular: se le pide por socket ('pantalla:pedida'); su dueño acepta en la app y luego
 *    en el aviso de Android (obligatorio), y la APK sube las fotos (POST /movil/pantallas/:id/frame).
 *
 * Solo se guarda en memoria la ÚLTIMA foto de cada vista, nunca en disco. Si quien mira deja
 * de pedirlas, la vista termina sola y la PC o el celular dejan de mandar.
 */
export type TipoPantalla = 'pc' | 'celular';
export type EstadoVista = 'esperando' | 'activa' | 'rechazada' | 'terminada';

interface Vista {
  id: string;
  tiendaId: string;
  tipo: TipoPantalla;
  /** PC: id de su sesión de EscolaresPRO. Celular: su dispositivoId. */
  objetivo: string;
  objetivoNombre: string;
  /** Celular: cuenta de escolares del celular que se mira (para hablarle por socket). */
  objetivoCuenta: string | null;
  /** Id interno (`tienda:usuario`) de quien mira. */
  espectador: string;
  espectadorNombre: string;
  estado: EstadoVista;
  mensaje: string | null;
  frame: Buffer | null;
  frameNum: number;
  frameEn: number | null;
  /** Última vez que quien mira preguntó: sin preguntar un rato, la vista termina. */
  vistoEn: number;
  creadaEn: number;
  terminadaEn: number | null;
}

/** Tiempo para que la PC empiece a mandar o el dueño del celular acepte. */
const ESPERA_MS = 45_000;
/** Sin que quien mira pregunte en este tiempo, se corta. */
const VIGENCIA_ESPECTADOR_MS = 12_000;
/** Ya terminada, se conserva un momento para que quien mira vea por qué. */
const RETENER_MS = 30_000;
export const MAX_FRAME_BYTES = 2 * 1024 * 1024;

const vistas = new Map<string, Vista>();

const abierta = (v: Vista) => v.estado === 'esperando' || v.estado === 'activa';

function terminar(v: Vista, estado: 'rechazada' | 'terminada', mensaje: string): void {
  if (!abierta(v)) return;
  v.estado = estado;
  v.mensaje = mensaje;
  v.frame = null;
  v.terminadaEn = Date.now();
  // El celular que compartía deja de capturar al instante (la APK también lo sabe en su próximo envío).
  if (v.tipo === 'celular' && v.objetivoCuenta) emitirADispositivo(v.objetivoCuenta, v.objetivo, 'pantalla:terminada', { id: v.id });
}

function obtener(id: string): Vista {
  const v = vistas.get(id);
  if (!v) throw new ErrorAutorizaciones(404, 'Esa pantalla ya no se está compartiendo');
  return v;
}

// ---------------------------------------------------------------- quien mira

export interface Espectador {
  _id: string;
  sellhubNombre: string;
  tiendaId: string;
}

/**
 * Pide ver una pantalla. `objetivo` ya resuelto por la ruta (sesión de la PC, o dispositivo
 * y cuenta del celular). Quien mira tiene una sola vista abierta a la vez.
 */
export function crearVista(
  espectador: Espectador,
  datos: { tipo: TipoPantalla; objetivo: string; objetivoNombre: string; objetivoCuenta?: string | null },
  tiendaNombre: string,
): { id: string } {
  for (const v of vistas.values()) {
    if (v.espectador === espectador._id && abierta(v)) terminar(v, 'terminada', 'Se abrió otra pantalla');
  }
  const ahora = Date.now();
  const v: Vista = {
    id: crypto.randomUUID(),
    tiendaId: espectador.tiendaId,
    tipo: datos.tipo,
    objetivo: datos.objetivo,
    objetivoNombre: datos.objetivoNombre.slice(0, 150),
    objetivoCuenta: datos.objetivoCuenta ?? null,
    espectador: espectador._id,
    espectadorNombre: espectador.sellhubNombre,
    estado: 'esperando',
    mensaje: null,
    frame: null,
    frameNum: 0,
    frameEn: null,
    vistoEn: ahora,
    creadaEn: ahora,
    terminadaEn: null,
  };
  vistas.set(v.id, v);
  if (v.tipo === 'celular' && v.objetivoCuenta) {
    emitirADispositivo(v.objetivoCuenta, v.objetivo, 'pantalla:pedida', {
      id: v.id,
      espectadorNombre: v.espectadorNombre,
      tiendaNombre,
    });
  }
  return { id: v.id };
}

function deEspectador(usuarios: string[], id: string): Vista {
  const v = obtener(id);
  if (!usuarios.includes(v.espectador)) throw new ErrorAutorizaciones(404, 'Esa pantalla ya no se está compartiendo');
  v.vistoEn = Date.now();
  return v;
}

export function estadoVista(usuarios: string[], id: string) {
  const v = deEspectador(usuarios, id);
  return {
    id: v.id,
    tipo: v.tipo,
    estado: v.estado,
    mensaje: v.mensaje,
    objetivoNombre: v.objetivoNombre,
    frameNum: v.frameNum,
    frameEn: v.frameEn ? new Date(v.frameEn).toISOString() : null,
  };
}

export function frameVista(usuarios: string[], id: string): Buffer | null {
  return deEspectador(usuarios, id).frame;
}

export function cerrarVista(usuarios: string[], id: string): void {
  const v = vistas.get(id);
  if (v && usuarios.includes(v.espectador)) terminar(v, 'terminada', 'Se cerró la pantalla');
}

// ---------------------------------------------------------------- lo que se mira

function guardarFrame(v: Vista, frame: Buffer): { seguir: boolean } {
  if (!abierta(v)) return { seguir: false };
  if (frame.length === 0 || frame.length > MAX_FRAME_BYTES) throw new ErrorAutorizaciones(413, 'Imagen inválida o demasiado grande');
  v.estado = 'activa';
  v.frame = frame;
  v.frameNum += 1;
  v.frameEn = Date.now();
  return { seguir: true };
}

/** PC: las vistas pedidas para SU sesión. */
export function vistasDePc(tiendaId: string, sesionId: string) {
  return [...vistas.values()]
    .filter((v) => v.tipo === 'pc' && v.tiendaId === tiendaId && v.objetivo === sesionId && abierta(v))
    .map((v) => ({ id: v.id, espectadorNombre: v.espectadorNombre }));
}

export function frameDePc(tiendaId: string, id: string, frame: Buffer): { seguir: boolean } {
  const v = vistas.get(id);
  if (!v || v.tipo !== 'pc' || v.tiendaId !== tiendaId) return { seguir: false };
  return guardarFrame(v, frame);
}

/** Celular: solo el mismo celular al que se le pidió. */
function deCelular(id: string, dispositivoId: string): Vista | null {
  const v = vistas.get(id);
  return v && v.tipo === 'celular' && v.objetivo === dispositivoId ? v : null;
}

export function frameDeCelular(id: string, dispositivoId: string, frame: Buffer): { seguir: boolean } {
  const v = deCelular(id, dispositivoId);
  return v ? guardarFrame(v, frame) : { seguir: false };
}

export function rechazarDesdeCelular(id: string, dispositivoId: string, motivo?: unknown): void {
  const v = deCelular(id, dispositivoId);
  if (!v) return;
  const texto = typeof motivo === 'string' && motivo.trim() ? motivo.trim().slice(0, 150) : 'No aceptó compartir su pantalla';
  terminar(v, 'rechazada', texto);
}

/** El celular dejó de compartir (botón de la notificación). */
export function terminarDesdeCelular(id: string, dispositivoId: string): void {
  const v = deCelular(id, dispositivoId);
  if (v) terminar(v, 'terminada', 'Dejó de compartir su pantalla');
}

// ---------------------------------------------------------------- limpieza

export function iniciarLimpiezaPantallas(): void {
  setInterval(() => {
    const ahora = Date.now();
    for (const v of vistas.values()) {
      if (v.estado === 'esperando' && ahora - v.creadaEn > ESPERA_MS) {
        terminar(v, 'terminada', v.tipo === 'pc' ? 'La PC no respondió (¿sigue abierto EscolaresPRO y actualizado?)' : 'No respondió a tiempo');
      } else if (abierta(v) && ahora - v.vistoEn > VIGENCIA_ESPECTADOR_MS) {
        terminar(v, 'terminada', 'Se dejó de ver');
      } else if (v.terminadaEn && ahora - v.terminadaEn > RETENER_MS) {
        vistas.delete(v.id);
      }
    }
  }, 4000);
}
