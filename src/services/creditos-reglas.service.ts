import { database } from '../config/database';
import { CreditoReglas } from '../models';

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

/** Total financiado y monto de cada cuota, con interés simple por quincena sobre el subtotal (sin IVA). */
export function simularCredito(reglas: CreditoReglas, monto: number): { total: number; cuotaMonto: number } {
  const total = round(monto * (1 + reglas.tasaQuincenal * reglas.cuotas));
  return { total, cuotaMonto: round(total / reglas.cuotas) };
}
