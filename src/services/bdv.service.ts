// Consulta a la API de conciliación del Banco de Venezuela para confirmar que un Pago
// Móvil o una transferencia llegó a la cuenta de Escolares. Misma integración que usa sellhub en caja
// (sellhub/src/services/bdv.ts); la API key vive solo en el .env del servidor.

/** Teléfono (Pago Móvil BDV) de Escolares al que el cliente paga. */
export const TELEFONO_DESTINO_BDV = '04144329235';

const RUTA_POR_DEFECTO = '/getMovement';

export interface ConsultaPagoBdv {
  /** Con prefijo de nacionalidad, sin puntos ni guiones: V12345678. */
  cedulaPagador: string;
  /** 11 dígitos: 04141234567. */
  telefonoPagador: string;
  referencia: string;
  /** YYYY-MM-DD */
  fechaPago: string;
  /** Monto en Bs con dos decimales, como texto: "1250.00". */
  importe: string;
  /** Código SUDEBAN de 4 dígitos del banco del pagador: "0102". */
  bancoOrigen: string;
}

export interface ResultadoPagoBdv {
  /** code 1000: el banco encontró la transacción y es la primera vez que se consulta. */
  valido: boolean;
  /** El pago existe pero ya se había conciliado antes (desde la app o desde caja). */
  yaConciliado: boolean;
  code: number | null;
  mensaje: string;
}

export async function consultarPagoBdv(input: ConsultaPagoBdv): Promise<ResultadoPagoBdv> {
  const apiKey = process.env.API_BDV_KEY;
  const baseUrl = process.env.API_BDV_URL;
  if (!apiKey || !baseUrl) {
    throw new Error('La validación con BDV no está configurada (falta API_BDV_KEY/API_BDV_URL en .env)');
  }

  const url = `${baseUrl.replace(/\/+$/, '')}${process.env.API_BDV_PATH || RUTA_POR_DEFECTO}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-API-Key': apiKey },
    body: JSON.stringify({ ...input, telefonoDestino: TELEFONO_DESTINO_BDV }),
    signal: AbortSignal.timeout(20000),
  });

  let json: { code?: unknown; message?: unknown } | null = null;
  try {
    json = (await res.json()) as { code?: unknown; message?: unknown };
  } catch {
    // respuesta no JSON: queda como no válido
  }

  // BDV manda los acentos mal codificados ("Transacci¿¿n realizada").
  const mensaje = (typeof json?.message === 'string' ? json.message : '').replace(/¿¿/g, 'ó');
  const code = Number.isFinite(Number(json?.code)) ? Number(json?.code) : null;
  // El status HTTP/JSON es 200 también cuando el pago no existe; lo que decide es el code.
  // "Ya fue conciliado" viene con code 1010 igual que "no existe", así que se reconoce por el texto.
  const yaConciliado = mensaje.toLowerCase().includes('ya fue conciliado');

  return {
    valido: res.ok && code === 1000,
    yaConciliado,
    code,
    mensaje: mensaje || `El banco no confirmó el pago (HTTP ${res.status})`,
  };
}
