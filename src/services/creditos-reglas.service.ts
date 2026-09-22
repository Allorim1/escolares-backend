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

export function calcularIva(reglas: CreditoReglas, subtotal: number): number {
  return round(subtotal * reglas.ivaTasa);
}

/** Total financiado y monto de cada cuota, con interés simple por quincena sobre el subtotal (sin IVA). */
export function simularCredito(reglas: CreditoReglas, monto: number): { total: number; cuotaMonto: number } {
  const total = round(monto * (1 + reglas.tasaQuincenal * reglas.cuotas));
  return { total, cuotaMonto: round(total / reglas.cuotas) };
}
