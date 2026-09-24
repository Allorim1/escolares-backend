import { Response } from 'express';
import fs from 'fs';
import { Request } from 'express';
import QRCode from 'qrcode';
import {
  CreditoDocumentoCampo,
  CreditoEstadoVerificacion,
  CreditoPago,
  CreditoPagoStatus,
  CreditoProducto,
  CreditoReglas,
  CreditoSolicitud,
  CreditoSolicitudStatus,
  CreditoUsuario,
} from '../models';
import { database } from '../config/database';
import { calcularIva, getReglas, limiteTotal, nivelPorCuotasPagadas, simularCredito } from '../services/creditos-reglas.service';
import { rutaAbsolutaSegura } from '../services/creditos-storage.service';

/** Prefijo que identifica un QR de compra de créditos, para no confundirlo con cualquier
 *  otro código que el cliente pueda escanear por error. */
const QR_PREFIJO = 'ESCOLARES-CREDITO:';

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Cuánto se ha pagado de la factura hasta ahora (con respaldo para créditos activados
 *  antes de que existiera este campo). */
function montoPagadoDe(s: CreditoSolicitud): number {
  return s.montoPagado ?? s.pagoInicial ?? s.factura?.iva ?? 0;
}

/**
 * Cuánto de la línea de crédito del cliente sigue comprometido por esta solicitud. Para un
 * crédito activo se va liberando a medida que se paga la factura; en cualquier otro estado
 * (todavía sin pago confirmado) sigue comprometido el monto completo.
 */
function montoComprometido(s: CreditoSolicitud): number {
  if (s.status === 'activo' && s.factura) {
    return Math.max(0, round(s.factura.total - montoPagadoDe(s)));
  }
  return s.monto;
}

function nombreAdmin(req: Request): string {
  const user = (req as any).user;
  return user?.nombre || user?.username || user?.email || 'Sistema';
}

function sinPassword(usuario: CreditoUsuario) {
  const { passwordHash: _passwordHash, ...resto } = usuario;
  return resto;
}

/**
 * % de cuotas pagadas a tiempo de un cliente, reconstruido a partir de sus pagos
 * verificados: para cada cuota ya vencida de cada crédito activo/pagado, se busca cuándo
 * el acumulado de pagos alcanzó el monto que esa cuota exigía y se compara contra su
 * fecha de vencimiento (activadoEn + diasEntreCuotas × número de cuota).
 */
async function calcularPuntualidad(usuarioId: string): Promise<{ cuotasEvaluadas: number; cuotasATiempo: number; porcentaje: number }> {
  const reglas = await getReglas();
  const diasEntreCuotasMs = reglas.diasEntreCuotas * 24 * 60 * 60 * 1000;

  const solicitudes = await database
    .getCollection<CreditoSolicitud>('creditos_solicitudes')
    .find({ usuarioId, status: { $in: ['activo', 'pagado'] }, activadoEn: { $exists: true } })
    .toArray();

  let cuotasEvaluadas = 0;
  let cuotasATiempo = 0;

  for (const s of solicitudes) {
    if (!s.activadoEn || !s.factura || !s.cuotaMonto) continue;

    const pagos = await database
      .getCollection<CreditoPago>('creditos_pagos')
      .find({ solicitudId: s.id, status: 'verificado' })
      .sort({ verificadoEn: 1 })
      .toArray();

    const pagoInicial = s.pagoInicial ?? s.factura.iva;
    const activado = new Date(s.activadoEn).getTime();
    const cuotasVencidas = Math.min(s.cuotas, Math.floor((Date.now() - activado) / diasEntreCuotasMs));

    for (let i = 1; i <= cuotasVencidas; i++) {
      const montoNecesario = pagoInicial + s.cuotaMonto * i;
      const vencimiento = activado + diasEntreCuotasMs * i;

      let acumulado = pagoInicial;
      let fechaAlcanzado: number | null = null;
      for (const p of pagos) {
        acumulado += p.monto;
        if (acumulado >= montoNecesario - 0.01) {
          fechaAlcanzado = p.verificadoEn ? new Date(p.verificadoEn).getTime() : null;
          break;
        }
      }

      cuotasEvaluadas++;
      if (fechaAlcanzado !== null && fechaAlcanzado <= vencimiento) {
        cuotasATiempo++;
      }
    }
  }

  const porcentaje = cuotasEvaluadas > 0 ? Math.round((cuotasATiempo / cuotasEvaluadas) * 100) : 100;
  return { cuotasEvaluadas, cuotasATiempo, porcentaje };
}

/**
 * Suma `cantidad` cuotas al acumulado histórico del cliente y, si con eso alcanza el
 * umbral configurado en Reglas, lo sube de nivel automáticamente. Nunca lo baja: si las
 * reglas cambiaron y el umbral calculado da un nivel menor al que ya tiene, se conserva el
 * nivel actual (puede haber sido asignado a mano desde "Cambiar nivel").
 */
async function acreditarCuotasPagadas(usuarioId: string, cantidad: number): Promise<void> {
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

export class CreditosAdminController {
  /**
   * Última ubicación conocida de cada cliente (reportada al aceptar una compra o declarar
   * un pago), para el módulo "Ubicación de clientes" del panel. El centrado en el staff y
   * el filtrado por cercanía se resuelven en el frontend con su propia geolocalización.
   */
  async listarUbicaciones(_req: Request, res: Response): Promise<void> {
    const usuarios = await database
      .getCollection<CreditoUsuario>('creditos_usuarios')
      .find({ ultimaUbicacion: { $exists: true } })
      .toArray();

    res.json(
      usuarios.map((u) => ({
        usuarioId: u.id,
        nombre: u.nombre,
        telefono: u.telefono,
        lat: u.ultimaUbicacion!.lat,
        lng: u.ultimaUbicacion!.lng,
        actualizadaEn: u.ultimaUbicacion!.actualizadaEn,
      })),
    );
  }

  async listarUsuarios(req: Request, res: Response): Promise<void> {
    const status = req.query.status as CreditoEstadoVerificacion | undefined;
    const filtro = status ? { status } : {};
    const usuarios = await database
      .getCollection<CreditoUsuario>('creditos_usuarios')
      .find(filtro)
      .sort({ createdAt: -1 })
      .toArray();
    res.json(usuarios.map(sinPassword));
  }

  async obtenerUsuario(req: Request, res: Response): Promise<void> {
    const usuario = await database.getCollection<CreditoUsuario>('creditos_usuarios').findOne({ id: req.params.id });
    if (!usuario) {
      res.status(404).json({ error: 'Usuario no encontrado' });
      return;
    }
    res.json(sinPassword(usuario));
  }

  /** Búsqueda por cédula (verificacion.documento), nombre o teléfono, para armar una compra. */
  async buscarUsuarios(req: Request, res: Response): Promise<void> {
    const q = ((req.query.q as string) || '').trim();
    if (!q) {
      res.json([]);
      return;
    }

    const regex = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    const usuarios = await database
      .getCollection<CreditoUsuario>('creditos_usuarios')
      .find({ $or: [{ nombre: regex }, { telefono: regex }, { 'verificacion.documento': regex }] })
      .limit(20)
      .toArray();

    const reglas = await getReglas();
    const solicitudes = await database
      .getCollection<CreditoSolicitud>('creditos_solicitudes')
      .find({ usuarioId: { $in: usuarios.map((u) => u.id) }, status: { $in: ['solicitado', 'activo', 'pendiente_aceptacion', 'esperando_pago'] } })
      .toArray();

    res.json(
      usuarios.map((u) => {
        const usado = solicitudes.filter((s) => s.usuarioId === u.id).reduce((sum, s) => sum + montoComprometido(s), 0);
        const limite = limiteTotal(reglas, u);
        return {
          ...sinPassword(u),
          disponible: Math.max(0, limite - usado),
          limite,
        };
      }),
    );
  }

  async documentoUsuario(req: Request, res: Response): Promise<void> {
    const { id, campo } = req.params;
    const usuario = await database.getCollection<CreditoUsuario>('creditos_usuarios').findOne({ id });
    const archivo = usuario?.verificacion?.documentos?.[campo as CreditoDocumentoCampo];
    if (!archivo) {
      res.status(404).json({ error: 'Documento no encontrado' });
      return;
    }

    const ruta = rutaAbsolutaSegura(archivo.path);
    if (!ruta || !fs.existsSync(ruta)) {
      res.status(404).json({ error: 'Documento no encontrado' });
      return;
    }

    res.setHeader('Content-Type', archivo.mimetype);
    fs.createReadStream(ruta).pipe(res);
  }

  async aprobarVerificacion(req: Request, res: Response): Promise<void> {
    const { id } = req.params;
    const usuario = await database.getCollection<CreditoUsuario>('creditos_usuarios').findOne({ id });
    if (!usuario) {
      res.status(404).json({ error: 'Usuario no encontrado' });
      return;
    }
    if (usuario.status !== 'en_revision') {
      res.status(400).json({ error: 'La cuenta no está en revisión' });
      return;
    }

    await database.getCollection<CreditoUsuario>('creditos_usuarios').updateOne(
      { id },
      {
        $set: {
          status: 'verificado',
          updatedAt: new Date(),
          'verificacion.revisadoPor': nombreAdmin(req),
          'verificacion.revisadoEn': new Date(),
        },
        $unset: { 'verificacion.motivoRechazo': '' },
      },
    );
    res.json({ message: 'Cuenta verificada' });
  }

  async rechazarVerificacion(req: Request, res: Response): Promise<void> {
    const { id } = req.params;
    const { motivo } = req.body;
    const usuario = await database.getCollection<CreditoUsuario>('creditos_usuarios').findOne({ id });
    if (!usuario) {
      res.status(404).json({ error: 'Usuario no encontrado' });
      return;
    }
    if (usuario.status !== 'en_revision') {
      res.status(400).json({ error: 'La cuenta no está en revisión' });
      return;
    }

    await database.getCollection<CreditoUsuario>('creditos_usuarios').updateOne(
      { id },
      {
        $set: {
          status: 'rechazado',
          updatedAt: new Date(),
          'verificacion.revisadoPor': nombreAdmin(req),
          'verificacion.revisadoEn': new Date(),
          'verificacion.motivoRechazo': (motivo || '').trim() || 'No especificado',
        },
      },
    );
    res.json({ message: 'Verificación rechazada' });
  }

  async cambiarNivel(req: Request, res: Response): Promise<void> {
    const { id } = req.params;
    const nivel = Number(req.body.nivel);
    const reglas = await getReglas();

    if (!Number.isInteger(nivel) || nivel < 1 || nivel > reglas.nivelMaximo) {
      res.status(400).json({ error: `El nivel debe estar entre 1 y ${reglas.nivelMaximo}` });
      return;
    }

    const result = await database
      .getCollection<CreditoUsuario>('creditos_usuarios')
      .findOneAndUpdate({ id }, { $set: { nivel, updatedAt: new Date() } }, { returnDocument: 'after' });

    if (!result) {
      res.status(404).json({ error: 'Usuario no encontrado' });
      return;
    }
    res.json(sinPassword(result));
  }

  /** Crédito adicional otorgado a mano a un cliente puntual, por encima de lo que le da su nivel. */
  async actualizarExtensionCredito(req: Request, res: Response): Promise<void> {
    const { id } = req.params;
    const monto = Number(req.body.monto);
    if (!Number.isFinite(monto) || monto < 0) {
      res.status(400).json({ error: 'El monto debe ser un número mayor o igual a 0' });
      return;
    }

    const result = await database
      .getCollection<CreditoUsuario>('creditos_usuarios')
      .findOneAndUpdate({ id }, { $set: { extensionCredito: round(monto), updatedAt: new Date() } }, { returnDocument: 'after' });

    if (!result) {
      res.status(404).json({ error: 'Usuario no encontrado' });
      return;
    }
    res.json(sinPassword(result));
  }

  /** Para el módulo "Ampliar Crédito": % de cuotas que este cliente pagó a tiempo. */
  async puntualidad(req: Request, res: Response): Promise<void> {
    const { id } = req.params;
    const resultado = await calcularPuntualidad(String(id));
    res.json(resultado);
  }

  async listarSolicitudes(req: Request, res: Response): Promise<void> {
    const status = req.query.status as CreditoSolicitudStatus | undefined;
    const usuarioId = req.query.usuarioId as string | undefined;
    const filtro: Record<string, unknown> = {};
    if (status) filtro.status = status;
    if (usuarioId) filtro.usuarioId = usuarioId;
    const solicitudes = await database
      .getCollection<CreditoSolicitud>('creditos_solicitudes')
      .find(filtro)
      .sort({ createdAt: -1 })
      .toArray();

    // Se agrega nombre/teléfono del solicitante para no obligar al panel a cruzar datos
    const usuarioIds = [...new Set(solicitudes.map((s) => s.usuarioId))];
    const usuarios = await database
      .getCollection<CreditoUsuario>('creditos_usuarios')
      .find({ id: { $in: usuarioIds } })
      .toArray();
    const usuarioPorId = new Map(usuarios.map((u) => [u.id, u]));

    res.json(
      solicitudes.map((s) => ({
        ...s,
        usuarioNombre: usuarioPorId.get(s.usuarioId)?.nombre,
        usuarioTelefono: usuarioPorId.get(s.usuarioId)?.telefono,
      })),
    );
  }

  /** Una sola solicitud por id, para que el panel haga polling del estado mientras
   *  espera a que el cliente confirme (o rechace) desde la app tras escanear el QR. */
  async obtenerSolicitud(req: Request, res: Response): Promise<void> {
    const { id } = req.params;
    const solicitud = await database.getCollection<CreditoSolicitud>('creditos_solicitudes').findOne({ id });
    if (!solicitud) {
      res.status(404).json({ error: 'Compra no encontrada' });
      return;
    }
    res.json(solicitud);
  }

  /**
   * Registra una compra por un monto en dólares (sin desglose de productos) y la deja
   * esperando que el cliente la confirme escaneando el QR desde la app.
   */
  async registrarCompra(req: Request, res: Response): Promise<void> {
    try {
      const { usuarioId, monto } = req.body as { usuarioId?: string; monto?: number };
      const subtotal = round(Number(monto));

      if (!usuarioId || !Number.isFinite(subtotal) || subtotal <= 0) {
        res.status(400).json({ error: 'Selecciona un usuario e ingresa un monto válido' });
        return;
      }

      const usuario = await database.getCollection<CreditoUsuario>('creditos_usuarios').findOne({ id: usuarioId });
      if (!usuario) {
        res.status(404).json({ error: 'Usuario no encontrado' });
        return;
      }
      if (usuario.status !== 'verificado') {
        res.status(400).json({ error: 'El usuario debe tener la cuenta verificada' });
        return;
      }

      const reglas = await getReglas();
      const solicitudesCollection = database.getCollection<CreditoSolicitud>('creditos_solicitudes');
      const existentes = await solicitudesCollection
        .find({ usuarioId, status: { $in: ['solicitado', 'activo', 'pendiente_aceptacion', 'esperando_pago'] } })
        .toArray();
      const usado = existentes.reduce((sum, s) => sum + montoComprometido(s), 0);
      const disponible = Math.max(0, limiteTotal(reglas, usuario) - usado);

      if (subtotal > disponible) {
        res.status(400).json({ error: `El monto (${subtotal}) supera el disponible del usuario (${disponible})` });
        return;
      }

      const iva = calcularIva(reglas, subtotal);
      const sim = simularCredito(reglas, subtotal);
      const ahora = new Date();
      const numeroFactura = `F-${String((await solicitudesCollection.countDocuments({ factura: { $exists: true } })) + 1).padStart(6, '0')}`;
      const id = Date.now().toString();

      const solicitud: CreditoSolicitud = {
        id,
        usuarioId,
        monto: subtotal,
        cuotas: reglas.cuotas,
        frecuencia: 'quincenal',
        cuotaMonto: sim.cuotaMonto,
        total: sim.total,
        proposito: 'Compra registrada en tienda',
        status: 'pendiente_aceptacion',
        cuotasPagadas: 0,
        createdAt: ahora,
        registradoPor: nombreAdmin(req),
        factura: { numero: numeroFactura, emitidaEn: ahora, subtotal, iva, total: round(subtotal + iva) },
      };

      await solicitudesCollection.insertOne(solicitud);

      const qrCode = await QRCode.toDataURL(`${QR_PREFIJO}${id}`, { margin: 1, width: 320 });
      res.status(201).json({ ...solicitud, qrCode });
    } catch (error) {
      console.error('Error al registrar compra:', error);
      res.status(500).json({ error: 'Error al registrar la compra' });
    }
  }

  /** El staff cancela una compra que armó por error, antes de que el cliente responda. */
  async cancelarCompra(req: Request, res: Response): Promise<void> {
    const { id } = req.params;
    const { motivo } = req.body;
    const solicitud = await database.getCollection<CreditoSolicitud>('creditos_solicitudes').findOne({ id });
    if (!solicitud) {
      res.status(404).json({ error: 'Compra no encontrada' });
      return;
    }
    if (solicitud.status !== 'pendiente_aceptacion') {
      res.status(400).json({ error: 'Solo se puede cancelar una compra pendiente de aceptación' });
      return;
    }

    await database.getCollection<CreditoSolicitud>('creditos_solicitudes').updateOne(
      { id },
      {
        $set: {
          status: 'rechazado',
          revisadoPor: nombreAdmin(req),
          motivoRechazo: (motivo || '').trim() || 'Cancelada por el staff',
        },
      },
    );
    res.json({ message: 'Compra cancelada' });
  }

  /**
   * El staff confirma que recibió (en efectivo o transferencia) el pago inicial que el
   * cliente eligió al aceptar la compra. Recién aquí arranca el crédito de verdad.
   */
  async confirmarPago(req: Request, res: Response): Promise<void> {
    const { id } = req.params;
    const solicitud = await database.getCollection<CreditoSolicitud>('creditos_solicitudes').findOne({ id });
    if (!solicitud) {
      res.status(404).json({ error: 'Compra no encontrada' });
      return;
    }
    if (solicitud.status !== 'esperando_pago') {
      res.status(400).json({ error: 'Esta compra no está esperando el pago inicial' });
      return;
    }

    const montoPagado = solicitud.pagoInicial ?? solicitud.factura?.iva ?? 0;
    await database.getCollection<CreditoSolicitud>('creditos_solicitudes').updateOne(
      { id },
      { $set: { status: 'activo', activadoEn: new Date(), revisadoPor: nombreAdmin(req), montoPagado } },
    );
    res.json({ message: 'Pago inicial confirmado, crédito activado' });
  }

  /** Abonos (Pago Móvil / Transferencia) declarados por los clientes, para el módulo de verificación. */
  async listarPagos(req: Request, res: Response): Promise<void> {
    const status = req.query.status as CreditoPagoStatus | undefined;
    const filtro: Record<string, unknown> = {};
    if (status) filtro.status = status;

    const pagos = await database
      .getCollection<CreditoPago>('creditos_pagos')
      .find(filtro)
      .sort({ createdAt: -1 })
      .toArray();

    const usuarioIds = [...new Set(pagos.map((p) => p.usuarioId))];
    const solicitudIds = [...new Set(pagos.map((p) => p.solicitudId))];
    const [usuarios, solicitudes] = await Promise.all([
      database.getCollection<CreditoUsuario>('creditos_usuarios').find({ id: { $in: usuarioIds } }).toArray(),
      database.getCollection<CreditoSolicitud>('creditos_solicitudes').find({ id: { $in: solicitudIds } }).toArray(),
    ]);
    const usuarioPorId = new Map(usuarios.map((u) => [u.id, u]));
    const solicitudPorId = new Map(solicitudes.map((s) => [s.id, s]));

    res.json(
      pagos.map((p) => ({
        ...p,
        usuarioNombre: usuarioPorId.get(p.usuarioId)?.nombre,
        usuarioTelefono: usuarioPorId.get(p.usuarioId)?.telefono,
        facturaNumero: solicitudPorId.get(p.solicitudId)?.factura?.numero,
      })),
    );
  }

  /**
   * El staff confirma (contra el estado de cuenta del banco) que el abono declarado sí
   * llegó: se suma a montoPagado de la solicitud y, si con eso se cubre la factura
   * completa, el crédito pasa a 'pagado'.
   */
  async verificarPago(req: Request, res: Response): Promise<void> {
    const { id } = req.params;
    const pago = await database.getCollection<CreditoPago>('creditos_pagos').findOne({ id });
    if (!pago) {
      res.status(404).json({ error: 'Pago no encontrado' });
      return;
    }
    if (pago.status !== 'pendiente_verificacion') {
      res.status(400).json({ error: 'Este pago ya fue procesado' });
      return;
    }

    const solicitud = await database.getCollection<CreditoSolicitud>('creditos_solicitudes').findOne({ id: pago.solicitudId });
    if (!solicitud || !solicitud.factura) {
      res.status(404).json({ error: 'La compra asociada ya no existe' });
      return;
    }

    const montoPagado = round(montoPagadoDe(solicitud) + pago.monto);
    const totalFactura = solicitud.factura.total;
    const nuevoStatus: CreditoSolicitudStatus = montoPagado >= totalFactura - 0.01 ? 'pagado' : 'activo';
    // Solo para mostrar el progreso ("2 de 3 cuotas"); el saldo real ya lo maneja montoPagado.
    const cuotasPagadas = Math.min(
      solicitud.cuotas,
      Math.max(0, Math.round((montoPagado - (solicitud.pagoInicial ?? solicitud.factura.iva)) / solicitud.cuotaMonto)),
    );
    const cuotasNuevas = Math.max(0, cuotasPagadas - solicitud.cuotasPagadas);

    await Promise.all([
      database.getCollection<CreditoSolicitud>('creditos_solicitudes').updateOne(
        { id: solicitud.id },
        { $set: { montoPagado, status: nuevoStatus, cuotasPagadas } },
      ),
      database.getCollection<CreditoPago>('creditos_pagos').updateOne(
        { id },
        { $set: { status: 'verificado', verificadoPor: nombreAdmin(req), verificadoEn: new Date() } },
      ),
      // Sube de nivel automáticamente según las cuotas que este pago recién completó.
      acreditarCuotasPagadas(pago.usuarioId, cuotasNuevas),
    ]);
    res.json({ message: 'Pago verificado', montoPagado, status: nuevoStatus });
  }

  /** El staff no encontró el abono declarado en el estado de cuenta del banco. */
  async rechazarPago(req: Request, res: Response): Promise<void> {
    const { id } = req.params;
    const { motivo } = req.body;
    const pago = await database.getCollection<CreditoPago>('creditos_pagos').findOne({ id });
    if (!pago) {
      res.status(404).json({ error: 'Pago no encontrado' });
      return;
    }
    if (pago.status !== 'pendiente_verificacion') {
      res.status(400).json({ error: 'Este pago ya fue procesado' });
      return;
    }

    await database.getCollection<CreditoPago>('creditos_pagos').updateOne(
      { id },
      {
        $set: {
          status: 'rechazado',
          verificadoPor: nombreAdmin(req),
          verificadoEn: new Date(),
          motivoRechazo: (motivo || '').trim() || 'No se encontró el pago en el banco',
        },
      },
    );
    res.json({ message: 'Pago rechazado' });
  }

  async aprobarSolicitud(req: Request, res: Response): Promise<void> {
    const { id } = req.params;
    const solicitud = await database.getCollection<CreditoSolicitud>('creditos_solicitudes').findOne({ id });
    if (!solicitud) {
      res.status(404).json({ error: 'Solicitud no encontrada' });
      return;
    }
    if (solicitud.status !== 'solicitado') {
      res.status(400).json({ error: 'La solicitud no está pendiente' });
      return;
    }

    await database.getCollection<CreditoSolicitud>('creditos_solicitudes').updateOne(
      { id },
      { $set: { status: 'activo', activadoEn: new Date(), revisadoPor: nombreAdmin(req) } },
    );
    res.json({ message: 'Crédito aprobado' });
  }

  async rechazarSolicitud(req: Request, res: Response): Promise<void> {
    const { id } = req.params;
    const { motivo } = req.body;
    const solicitud = await database.getCollection<CreditoSolicitud>('creditos_solicitudes').findOne({ id });
    if (!solicitud) {
      res.status(404).json({ error: 'Solicitud no encontrada' });
      return;
    }
    if (solicitud.status !== 'solicitado') {
      res.status(400).json({ error: 'La solicitud no está pendiente' });
      return;
    }

    await database.getCollection<CreditoSolicitud>('creditos_solicitudes').updateOne(
      { id },
      { $set: { status: 'rechazado', revisadoPor: nombreAdmin(req), motivoRechazo: (motivo || '').trim() || 'No especificado' } },
    );
    res.json({ message: 'Solicitud rechazada' });
  }

  async registrarPago(req: Request, res: Response): Promise<void> {
    const { id } = req.params;
    const solicitud = await database.getCollection<CreditoSolicitud>('creditos_solicitudes').findOne({ id });
    if (!solicitud) {
      res.status(404).json({ error: 'Solicitud no encontrada' });
      return;
    }
    if (solicitud.status !== 'activo') {
      res.status(400).json({ error: 'El crédito no está activo' });
      return;
    }

    const cuotasPagadas = solicitud.cuotasPagadas + 1;
    const nuevoStatus: CreditoSolicitudStatus = cuotasPagadas >= solicitud.cuotas ? 'pagado' : 'activo';

    await Promise.all([
      database
        .getCollection<CreditoSolicitud>('creditos_solicitudes')
        .updateOne({ id }, { $set: { cuotasPagadas, status: nuevoStatus } }),
      acreditarCuotasPagadas(solicitud.usuarioId, 1),
    ]);

    res.json({ message: 'Pago registrado', cuotasPagadas, status: nuevoStatus });
  }

  async listarProductos(_req: Request, res: Response): Promise<void> {
    const productos = await database.getCollection<CreditoProducto>('creditos_productos').find({}).sort({ nombre: 1 }).toArray();
    res.json(productos);
  }

  async crearProducto(req: Request, res: Response): Promise<void> {
    const { nombre, descripcion, categoria, precio, icono } = req.body;
    if (!nombre?.trim() || !categoria || !Number.isFinite(Number(precio))) {
      res.status(400).json({ error: 'Nombre, categoría y precio son requeridos' });
      return;
    }

    const ahora = new Date();
    const producto: CreditoProducto = {
      id: Date.now().toString(),
      nombre: nombre.trim(),
      descripcion: (descripcion || '').trim(),
      categoria,
      precio: Number(precio),
      icono: icono || 'pricetag',
      activo: true,
      createdAt: ahora,
      updatedAt: ahora,
    };
    await database.getCollection<CreditoProducto>('creditos_productos').insertOne(producto);
    res.status(201).json(producto);
  }

  async actualizarProducto(req: Request, res: Response): Promise<void> {
    const { id } = req.params;
    const { nombre, descripcion, categoria, precio, icono, activo } = req.body;

    const cambios: Partial<CreditoProducto> = { updatedAt: new Date() };
    if (nombre !== undefined) cambios.nombre = nombre.trim();
    if (descripcion !== undefined) cambios.descripcion = descripcion.trim();
    if (categoria !== undefined) cambios.categoria = categoria;
    if (precio !== undefined) cambios.precio = Number(precio);
    if (icono !== undefined) cambios.icono = icono;
    if (activo !== undefined) cambios.activo = !!activo;

    const result = await database
      .getCollection<CreditoProducto>('creditos_productos')
      .findOneAndUpdate({ id }, { $set: cambios }, { returnDocument: 'after' });

    if (!result) {
      res.status(404).json({ error: 'Producto no encontrado' });
      return;
    }
    res.json(result);
  }

  async eliminarProducto(req: Request, res: Response): Promise<void> {
    const { id } = req.params;
    const result = await database.getCollection<CreditoProducto>('creditos_productos').deleteOne({ id });
    if (result.deletedCount === 0) {
      res.status(404).json({ error: 'Producto no encontrado' });
      return;
    }
    res.json({ message: 'Producto eliminado' });
  }

  async obtenerReglas(_req: Request, res: Response): Promise<void> {
    res.json(await getReglas());
  }

  async actualizarReglas(req: Request, res: Response): Promise<void> {
    const campos: (keyof CreditoReglas)[] = [
      'nivelBase',
      'factorNivel',
      'nivelMaximo',
      'cuotas',
      'diasEntreCuotas',
      'tasaQuincenal',
      'ivaTasa',
      'montoMinimo',
    ];
    const cambios: Partial<CreditoReglas> = { updatedAt: new Date() };
    for (const campo of campos) {
      if (req.body[campo] !== undefined) {
        const valor = Number(req.body[campo]);
        if (!Number.isFinite(valor) || valor < 0) {
          res.status(400).json({ error: `Valor inválido para ${campo}` });
          return;
        }
        (cambios as any)[campo] = valor;
      }
    }
    if (Array.isArray(req.body.categorias)) {
      cambios.categorias = req.body.categorias;
    }
    if (Array.isArray(req.body.nombresNiveles)) {
      cambios.nombresNiveles = req.body.nombresNiveles.map((n: unknown) => String(n ?? '').trim());
    }
    if (Array.isArray(req.body.cuotasParaNivel)) {
      const cuotasParaNivel = req.body.cuotasParaNivel.map((n: unknown) => Number(n));
      if (cuotasParaNivel.some((n: number) => !Number.isFinite(n) || n < 0)) {
        res.status(400).json({ error: 'Valor inválido en cuotas para subir de nivel' });
        return;
      }
      cambios.cuotasParaNivel = cuotasParaNivel;
    }

    await getReglas(); // asegura que el documento exista antes de actualizarlo
    const result = await database
      .getCollection<CreditoReglas>('creditos_reglas')
      .findOneAndUpdate({ id: 'reglas' }, { $set: cambios }, { returnDocument: 'after' });
    res.json(result);
  }
}

export const creditosAdminController = new CreditosAdminController();
