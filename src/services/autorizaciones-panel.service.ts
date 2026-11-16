import { database } from '../config/database';
import { emitirAUsuarios } from './autorizaciones-socket.service';
import { ErrorAutorizaciones } from './autorizaciones-vinculos.service';
import { crearEvento } from './autorizaciones-solicitudes.service';
import { listarTiendas, uid } from './autorizaciones-tiendas.service';

/**
 * Pestaña "Resumen" de la app de supervisores (ion/escolares-pro): ventas y cuadres del
 * día que sellhub manda cada minuto (POST /caja/panel). Solo la ven los usuarios de sellhub
 * con rol root: la lista viene con cada envío (campo `administradores`), porque los roles viven en sellhub.
 *
 * Se guarda el último de CADA TIENDA (_id = tiendaId) en Mongo para que sobreviva a un
 * reinicio. Con él se manda también el cierre del día de esa tienda, a la hora que se
 * configura en su sellhub (un mensaje por tienda).
 */
interface PanelGuardado {
  _id: string;
  panel: Record<string, unknown>;
  /** Ids de usuario del sellhub de esa tienda (simples, como los manda). */
  administradores: string[];
  recibidoEn: Date;
  /** Fecha (YYYY-MM-DD, Venezuela) del último cierre del día enviado. */
  reporteEnviado?: string;
}

const LIMITE_BYTES = 512 * 1024;
const ZONA = 'America/Caracas';

const coleccion = () => database.getCollection<PanelGuardado>('autorizaciones_panel');

const enMemoria = new Map<string, PanelGuardado | null>();

async function actual(tiendaId: string): Promise<PanelGuardado | null> {
  if (!enMemoria.has(tiendaId)) enMemoria.set(tiendaId, await coleccion().findOne({ _id: tiendaId }));
  return enMemoria.get(tiendaId) ?? null;
}

/** Admins de una tienda como ids internos (para el socket). */
const adminsInternos = (tiendaId: string, doc: PanelGuardado) => doc.administradores.map((a) => uid(tiendaId, a));

/** Lo que se sabe de un vínculo para decidir si ve el resumen de su tienda. */
export interface VinculoPanel {
  tiendaId: string;
  sellhubUsuarioId: string;
}

/**
 * Si una PC con una versión vieja de sellhub sigue abierta, sus envíos (sin las partes
 * nuevas, como el gráfico por hora, y a veces sin la lista de admins) pisarían el de las
 * PCs actualizadas cada minuto: el gráfico aparecía y desaparecía, y a ratos el celular
 * decía que el usuario no era root. Por eso un envío con un formato (`esquema`) más viejo
 * que el guardado se descarta mientras el guardado sea reciente.
 */
const VIGENCIA_ESQUEMA_MS = 10 * 60_000;

const esquemaDe = (panel: Record<string, unknown>): number =>
  typeof panel.esquema === 'number' && Number.isFinite(panel.esquema) ? panel.esquema : 1;

export async function guardarPanel(tiendaId: string, input: Record<string, unknown>): Promise<void> {
  const panel = input.panel;
  if (!panel || typeof panel !== 'object' || Array.isArray(panel)) {
    throw new ErrorAutorizaciones(400, 'Falta el resumen');
  }
  if (Buffer.byteLength(JSON.stringify(panel)) > LIMITE_BYTES) {
    throw new ErrorAutorizaciones(413, 'El resumen es demasiado grande');
  }
  const nuevo = panel as Record<string, unknown>;
  const previo = await actual(tiendaId);
  if (
    previo &&
    esquemaDe(nuevo) < esquemaDe(previo.panel) &&
    Date.now() - new Date(previo.recibidoEn).getTime() < VIGENCIA_ESQUEMA_MS
  ) {
    return;
  }
  const recibidos = Array.isArray(input.administradores)
    ? [...new Set(input.administradores.map((v) => String(v).trim()).filter((v) => v && v.length <= 36))].slice(0, 200)
    : [];
  // Una lista vacía (PC vieja o fallo al leer los roles) no deja a todos sin acceso.
  const administradores = recibidos.length ? recibidos : (previo?.administradores ?? []);
  const campos = { panel: nuevo, administradores, recibidoEn: new Date() };
  // $set (no replace) para conservar reporteEnviado.
  await coleccion().updateOne({ _id: tiendaId }, { $set: campos }, { upsert: true });
  const doc: PanelGuardado = { ...(previo ?? {}), _id: tiendaId, ...campos };
  enMemoria.set(tiendaId, doc);
  emitirAUsuarios(adminsInternos(tiendaId, doc), 'panel', vista(doc));
}

const vista = (doc: PanelGuardado) => ({ ...doc.panel, tiendaId: doc._id, recibidoEn: doc.recibidoEn.toISOString() });

/** Si ese usuario es root en su tienda según el último envío de esa tienda. */
export async function esAdministrador(v: VinculoPanel): Promise<boolean> {
  return (await actual(v.tiendaId))?.administradores.includes(v.sellhubUsuarioId) ?? false;
}

/** Última vez que llegó el resumen de una tienda (para Gestión Multienda). */
export async function ultimoPanel(tiendaId: string): Promise<Date | null> {
  return (await actual(tiendaId))?.recibidoEn ?? null;
}

export async function panelPara(v: VinculoPanel) {
  const doc = await actual(v.tiendaId);
  if (!doc?.administradores.includes(v.sellhubUsuarioId)) {
    throw new ErrorAutorizaciones(403, 'Solo los usuarios root ven el resumen');
  }
  return vista(doc);
}

// ---------------------------------------------------------------- cierre del día

/** Fecha y hora actuales en Venezuela: { fecha: 'YYYY-MM-DD', hora: 'HH:MM' }. */
function ahoraEnVenezuela(): { fecha: string; hora: string } {
  const partes = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: ZONA,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(new Date())
      .map((p) => [p.type, p.value]),
  );
  return { fecha: `${partes.year}-${partes.month}-${partes.day}`, hora: `${partes.hour}:${partes.minute}` };
}

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const monto = (n: number) => n.toLocaleString('es-VE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const lista = (v: unknown): Record<string, unknown>[] => (Array.isArray(v) ? v.filter((x) => x && typeof x === 'object') : []);

/** Texto del cierre del día a partir del último resumen recibido. */
function armarReporte(p: Record<string, unknown>, recibidoEn: Date) {
  const hoy = (p.hoy ?? {}) as Record<string, unknown>;
  const ayer = (p.ayer ?? {}) as Record<string, unknown>;
  const ventasUsd = num(hoy.ventasUsd);
  const ventasAyer = num(ayer.ventasUsd);
  const variacion = ventasAyer > 0 ? ((ventasUsd - ventasAyer) / ventasAyer) * 100 : null;
  const cuadres = lista(p.cuadres);
  const conDiferencia = cuadres.filter((c) => Math.abs(num(c.diferenciaUsd)) >= 0.005 || Math.abs(num(c.diferenciaBs)) >= 0.005);
  const sinCuadre = Array.isArray(p.cajasSinCuadre) ? p.cajasSinCuadre.map(String) : [];
  const comisiones = lista(p.comisionesHoy).reduce((s, c) => s + num(c.comisionUsd), 0);
  const agotandose = lista(p.inventarioBajo).length;
  const hora = new Intl.DateTimeFormat('es-VE', { timeZone: ZONA, hour: '2-digit', minute: '2-digit' }).format(recibidoEn);

  const detalles = [
    { etiqueta: 'Ventas', valor: `$ ${monto(ventasUsd)} / Bs. ${monto(num(hoy.ventasBs))}`, destacado: true },
    ...(variacion !== null ? [{ etiqueta: 'Contra ayer', valor: `${variacion > 0 ? '+' : ''}${variacion.toFixed(1)}%` }] : []),
    { etiqueta: 'Facturas', valor: String(num(hoy.facturas)) },
    { etiqueta: 'Ticket promedio', valor: `$ ${monto(num(hoy.ticketPromedioUsd))}` },
    { etiqueta: 'Devoluciones', valor: `${num(hoy.notasCredito)} · $ ${monto(num(hoy.devolucionesUsd))}` },
    ...lista(p.metodos).map((m) => ({
      etiqueta: String(m.etiqueta ?? 'Método').slice(0, 60),
      valor: `${m.moneda === 'BS' ? 'Bs.' : '$'} ${monto(num(m.monto))}`,
    })),
    { etiqueta: 'Cuadres', valor: `${cuadres.length} guardados${conDiferencia.length ? ` · ${conDiferencia.length} con diferencia` : ''}` },
    ...conDiferencia.map((c) => ({
      etiqueta: `Caja ${String(c.caja ?? '')}`.slice(0, 60),
      valor: `Diferencia $ ${monto(num(c.diferenciaUsd))} / Bs. ${monto(num(c.diferenciaBs))}`,
    })),
    ...(sinCuadre.length ? [{ etiqueta: 'Sin cuadre', valor: sinCuadre.join(', ') }] : []),
    { etiqueta: 'Comisiones del día', valor: `$ ${monto(comisiones)}` },
    ...(agotandose ? [{ etiqueta: 'Se están agotando', valor: `${agotandose} productos` }] : []),
    { etiqueta: 'Datos de las', valor: hora },
  ];

  const avisos = [conDiferencia.length ? `${conDiferencia.length} cuadre(s) con diferencia` : '', sinCuadre.length ? `${sinCuadre.length} caja(s) sin cuadre` : '']
    .filter(Boolean)
    .join(' · ');
  return {
    titulo: `📊 Cierre del día: $ ${monto(ventasUsd)}`,
    cuerpo: `${num(hoy.facturas)} facturas${variacion !== null ? ` · ${variacion > 0 ? '+' : ''}${variacion.toFixed(1)}% vs ayer` : ''}${avisos ? ` · ${avisos}` : ''}`,
    detalles,
  };
}

async function revisarCierreDelDia(tiendaId: string): Promise<void> {
  const doc = await actual(tiendaId);
  const config = (doc?.panel.reporteDiario ?? {}) as { activa?: unknown; hora?: unknown };
  if (!doc || config.activa !== true || typeof config.hora !== 'string') return;
  const { fecha, hora } = ahoraEnVenezuela();
  // Solo con datos de hoy, a partir de la hora configurada, una vez por día.
  if (doc.panel.fecha !== fecha || hora < config.hora || doc.reporteEnviado === fecha) return;
  // Si hay más de una instancia del backend, solo una lo marca y lo manda.
  const marcado = await coleccion().updateOne({ _id: tiendaId, reporteEnviado: { $ne: fecha } }, { $set: { reporteEnviado: fecha } });
  doc.reporteEnviado = fecha;
  if (marcado.modifiedCount !== 1) return;
  // crearEvento antepone el nombre de la tienda al push cuando hay varias.
  const reporte = armarReporte(doc.panel, doc.recibidoEn);
  await crearEvento(tiendaId, { tipo: 'reporte', ...reporte, usuario: null, equipo: null, destinatarios: doc.administradores });
}

/** Revisa cada minuto si toca mandar el cierre del día de cada tienda (uno por tienda). */
export function iniciarCierreDelDia(): void {
  setInterval(() => {
    listarTiendas()
      .then((tiendas) =>
        Promise.all(
          tiendas
            .filter((t) => t.activa)
            .map((t) => revisarCierreDelDia(t._id).catch((error) => console.error(`Cierre del día (${t.nombre}):`, error))),
        ),
      )
      .catch((error) => console.error('Cierre del día:', error));
  }, 60_000);
}
