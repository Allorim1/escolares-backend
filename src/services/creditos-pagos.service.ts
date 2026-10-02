import { database } from '../config/database';
import { CreditoPago, CreditoSolicitud, CreditoSolicitudStatus, CreditoUsuario } from '../models';
import { getReglas, nivelPorCuotasPagadas, totalConMora } from './creditos-reglas.service';

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Cuánto se ha pagado de la factura hasta ahora (con respaldo para créditos activados
 *  antes de que existiera este campo). */
function montoPagadoDe(s: CreditoSolicitud): number {
  return s.montoPagado ?? s.pagoInicial ?? s.factura?.iva ?? 0;
}

/**
 * Suma `cantidad` cuotas al acumulado histórico del cliente y, si con eso alcanza el
 * umbral configurado en Reglas, lo sube de nivel automáticamente. Nunca lo baja: si las
 * reglas cambiaron y el umbral calculado da un nivel menor al que ya tiene, se conserva el
 * nivel actual (puede haber sido asignado a mano desde "Cambiar nivel").
 */
export async function acreditarCuotasPagadas(usuarioId: string, cantidad: number): Promise<void> {
  if (cantidad <= 0) return;
  const usuario = await database.getCollection<CreditoUsuario>('creditos_usuarios').findOne({ id: usuarioId });
  if (!usuario) return;

  const reglas = await getReglas();
  const cuotasPagadasTotal = (usuario.cuotasPagadasTotal ?? 0) + cantidad;
  const nivel = Math.max(usuario.nivel, nivelPorCuotasPagadas(reglas, cuotasPagadasTotal));

  await database
    .getCollection<CreditoUsuario>('creditos_usuarios')
    .updateOne({ id: usuarioId }, { $set: { cuotasPagadasTotal, nivel } });
}

/**
 * Refleja en la solicitud un abono ya confirmado contra el banco: se suma a montoPagado y,
 * si con eso se cubre la factura completa, el crédito pasa a 'pagado'. Lo usan tanto la
 * verificación manual del staff (panel admin) como la automática con BDV (app, Pago Móvil).
 * El pago tiene que existir ya en creditos_pagos.
 */
export async function aplicarPagoVerificado(
  pago: CreditoPago,
  solicitud: CreditoSolicitud,
  verificadoPor: string,
): Promise<{ montoPagado: number; status: CreditoSolicitudStatus }> {
  const reglas = await getReglas();
  const montoPagado = round(montoPagadoDe(solicitud) + pago.monto);
  // Mora calculada sobre lo que se debía antes de este abono: lo que ya estaba vencido no
  // deja de contar solo porque ahora está pagando.
  const totalAPagar = totalConMora(solicitud, reglas);
  const status: CreditoSolicitudStatus = montoPagado >= totalAPagar - 0.01 ? 'pagado' : 'activo';
  // Solo para mostrar el progreso ("2 de 3 cuotas"); el saldo real ya lo maneja montoPagado.
  const cuotasPagadas = Math.min(
    solicitud.cuotas,
    Math.max(0, Math.round((montoPagado - (solicitud.pagoInicial ?? solicitud.factura?.iva ?? 0)) / solicitud.cuotaMonto)),
  );
  const cuotasNuevas = Math.max(0, cuotasPagadas - solicitud.cuotasPagadas);

  await Promise.all([
    database.getCollection<CreditoSolicitud>('creditos_solicitudes').updateOne(
      { id: solicitud.id },
      { $set: { montoPagado, status, cuotasPagadas } },
    ),
    database.getCollection<CreditoPago>('creditos_pagos').updateOne(
      { id: pago.id },
      { $set: { status: 'verificado', verificadoPor, verificadoEn: new Date() } },
    ),
    // Sube de nivel automáticamente según las cuotas que este pago recién completó.
    acreditarCuotasPagadas(pago.usuarioId, cuotasNuevas),
  ]);
  return { montoPagado, status };
}
