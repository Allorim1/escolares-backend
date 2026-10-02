// Tasa oficial del dólar (BCV), la misma fuente que GET /api/tasas en server.ts y que la
// app usa para mostrar el monto en Bs. Se necesita en el servidor para comprobar que los
// bolívares que el cliente pagó corresponden a los dólares que se le van a abonar.

const BCV_CURRENT_URL = 'https://rates.dolarvzla.com/bcv/current.json';
const CACHE_MS = 60_000;

let cache: { tasa: number; en: number } | null = null;

export async function obtenerTasaUsdBcv(): Promise<number> {
  if (cache && Date.now() - cache.en < CACHE_MS) return cache.tasa;

  const res = await fetch(BCV_CURRENT_URL, { signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error(`No se pudo obtener la tasa BCV (HTTP ${res.status})`);
  const data: any = await res.json();
  const tasa = Number(data?.current?.usd);
  if (!(tasa > 0)) throw new Error('La tasa BCV vino vacía');

  cache = { tasa, en: Date.now() };
  return tasa;
}
