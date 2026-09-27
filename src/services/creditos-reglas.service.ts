import { database } from '../config/database';
import { CreditoReglas, CreditoSolicitud } from '../models';

const REGLAS_ID = 'reglas' as const;

const DEFAULT_REGLAS: CreditoReglas = {
  id: REGLAS_ID,
  nivelBase: 100,
  factorNivel: 1.5,
  nivelMaximo: 5,
  cuotas: 3,
  diasEntreCuotas: 15,
  tasaQuincenal: 0.02,
  ivaTasa: 0.16,
  montoMinimo: 50,
  categorias: ['Útiles', 'Uniformes', 'Libros', 'Tecnología'],
  nombresNiveles: ['Bronce', 'Plata', 'Oro', 'Platino', 'Diamante'],
  // Cuotas necesarias, estando en cada nivel, para subir al siguiente (1→2, 2→3, 3→4, 4→5).
  cuotasParaNivel: [5, 10, 15, 20],
  updatedAt: new Date(),
};

/** Lee las reglas del negocio de crédito; las crea con los valores por defecto si no existen. */
export async function getReglas(): Promise<CreditoReglas> {
  const coleccion = database.getCollection<CreditoReglas>('creditos_reglas');
  const existentes = await coleccion.findOne({ id: REGLAS_ID });
  if (existentes) return existentes;

  await coleccion.insertOne(DEFAULT_REGLAS);
  return DEFAULT_REGLAS;
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Línea de crédito de un nivel (1..nivelMaximo): nivelBase * factorNivel^(nivel-1). */
export function limitePorNivel(reglas: CreditoReglas, nivel: number): number {
  const n = Math.min(Math.max(Math.floor(nivel), 1), reglas.nivelMaximo);
  return round(reglas.nivelBase * Math.pow(reglas.factorNivel, n - 1));
}

/** Línea de crédito real del cliente: la de su nivel más la extensión que se le haya
 *  otorgado a mano desde "Ampliar Crédito". */
export function limiteTotal(reglas: CreditoReglas, usuario: { nivel: number; extensionCredito?: number }): number {
  return round(limitePorNivel(reglas, usuario.nivel) + (usuario.extensionCredito ?? 0));
}

/** Nombre configurable del nivel (con respaldo si todavía no se le puso nombre). */
export function nombreNivel(reglas: CreditoReglas, nivel: number): string {
  const n = Math.min(Math.max(Math.floor(nivel), 1), reglas.nivelMaximo);
  return reglas.nombresNiveles?.[n - 1] || `Nivel ${n}`;
}

/**
 * Nivel que corresponde según las cuotas pagadas acumuladas en total (no se reinicia al
 * subir de nivel). cuotasParaNivel[i] son las cuotas que hacen falta, estando en el nivel
 * i+1, para llegar al nivel i+2 — se van sumando para comparar contra el acumulado.
 */
export function nivelPorCuotasPagadas(reglas: CreditoReglas, cuotasPagadasTotal: number): number {
  const incrementos = reglas.cuotasParaNivel ?? [];
  let acumulado = 0;
  let nivel = 1;
  for (let i = 0; i < incrementos.length && nivel < reglas.nivelMaximo; i++) {
    const requeridas = incrementos[i];
    if (!requeridas || requeridas <= 0) break;
    acumulado += requeridas;
    if (cuotasPagadasTotal < acumulado) break;
    nivel = i + 2;
  }
  return Math.min(nivel, reglas.nivelMaximo);
}

export function calcularIva(reglas: CreditoReglas, subtotal: number): number {
  return round(subtotal * reglas.ivaTasa);
}

/** El monto que se ingresa en Registrar Compra y Asignar Compra ya incluye IVA (es lo que
 *  paga el cliente); esto separa cuánto de eso es subtotal y cuánto es IVA. */
export function desglosarIva(reglas: CreditoReglas, montoConIva: number): { subtotal: number; iva: number } {
  const subtotal = round(montoConIva / (1 + reglas.ivaTasa));
  return { subtotal, iva: round(montoConIva - subtotal) };
}

/** Total financiado y monto de cada cuota, con interés simple por quincena sobre el subtotal (sin IVA). */
export function simularCredito(reglas: CreditoReglas, monto: number): { total: number; cuotaMonto: number } {
  const total = round(monto * (1 + reglas.tasaQuincenal * reglas.cuotas));
  return { total, cuotaMonto: round(total / reglas.cuotas) };
}

/**
 * Días de atraso de un crédito activo: busca la primera cuota que ya venció sin que
 * montoPagado la cubra, y devuelve cuántos días pasaron desde su vencimiento. 0 si no está
 * activo, no tiene fecha de activación, o va al día. Base para resaltar clientes atrasados
 * y para que el staff abra un caso de "pago atrasado" (Centro de Ayuda) pasados 7 días.
 */
export function diasAtrasoDe(s: CreditoSolicitud, reglas: CreditoReglas): number {
  if (s.status !== 'activo' || !s.activadoEn || !s.factura || !s.cuotaMonto) return 0;

  const DIA_MS = 24 * 60 * 60 * 1000;
  const diasEntreCuotasMs = reglas.diasEntreCuotas * DIA_MS;
  const activado = new Date(s.activadoEn).getTime();
  const pagoInicial = s.pagoInicial ?? s.factura.iva;
  const montoPagado = s.montoPagado ?? pagoInicial;

  for (let i = 1; i <= s.cuotas; i++) {
    const montoNecesario = pagoInicial + s.cuotaMonto * i;
    if (montoPagado < montoNecesario - 0.01) {
      const vencimiento = activado + diasEntreCuotasMs * i;
      return Math.max(0, Math.floor((Date.now() - vencimiento) / DIA_MS));
    }
  }
  return 0;
}

const DIA_MS = 24 * 60 * 60 * 1000;
const MORA_MONTO = 2;
const MORA_CADA_DIAS = 3;

/** Mora de una sola cuota, dado hace cuánto venció (en ms). $2 por cada 3 días de atraso;
 *  0 si `vencimientoMs` todavía no llega. Misma fórmula que penalizacionPorAtraso() en el
 *  credit.service.ts de la app — no se cobra de más ni de menos de lo que la app le muestra
 *  al cliente en "Próximos pagos". */
function moraPorVencimiento(vencimientoMs: number): number {
  const dias = Math.max(0, Math.floor((Date.now() - vencimientoMs) / DIA_MS));
  return Math.floor(dias / MORA_CADA_DIAS) * MORA_MONTO;
}

/** Mora acumulada a hoy de un crédito activo: suma la de CADA cuota vencida y sin pagar (más
 *  de una a la vez si el cliente se atrasó en varias). */
export function penalizacionAcumulada(s: CreditoSolicitud, reglas: CreditoReglas): number {
  if (s.status !== 'activo' || !s.activadoEn || !s.factura || !s.cuotaMonto) return 0;

  const diasEntreCuotasMs = reglas.diasEntreCuotas * DIA_MS;
  const activado = new Date(s.activadoEn).getTime();
  const pagoInicial = s.pagoInicial ?? s.factura.iva;
  const montoPagado = s.montoPagado ?? pagoInicial;

  let total = 0;
  for (let i = 1; i <= s.cuotas; i++) {
    const montoNecesario = pagoInicial + s.cuotaMonto * i;
    if (montoPagado < montoNecesario - 0.01) {
      total += moraPorVencimiento(activado + diasEntreCuotasMs * i);
    }
  }
  return round(total);
}

/**
 * Mora de la próxima cuota sin pagar (la número `cuotasPagadas + 1`), para cuando el staff
 * cobra en efectivo y hay que saber cuánto pedir además del monto fijo de la cuota (ver
 * registrarPago en creditos-admin.controller.ts). 0 si el crédito no está activo o esa
 * cuota todavía no vence.
 */
export function moraDeProximaCuota(s: CreditoSolicitud, reglas: CreditoReglas): number {
  if (s.status !== 'activo' || !s.activadoEn) return 0;
  const numeroCuota = s.cuotasPagadas + 1;
  if (numeroCuota > s.cuotas) return 0;

  const activado = new Date(s.activadoEn).getTime();
  const vencimiento = activado + reglas.diasEntreCuotas * DIA_MS * numeroCuota;
  return moraPorVencimiento(vencimiento);
}

/** Lo que realmente hay que pagar para saldar el crédito: la factura más la mora acumulada
 *  a hoy. Es la cifra que se debe usar para saber si ya está "pagado", no solo factura.total. */
export function totalConMora(s: CreditoSolicitud, reglas: CreditoReglas): number {
  const base = s.factura?.total ?? s.total;
  return round(base + penalizacionAcumulada(s, reglas));
}
