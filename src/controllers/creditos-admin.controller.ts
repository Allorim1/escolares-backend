import { Response } from 'express';
import fs from 'fs';
import crypto from 'crypto';
import argon2 from 'argon2';
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
  CreditoTicket,
  CreditoTicketEstado,
  CreditoUsuario,
} from '../models';
import { database } from '../config/database';
import { desglosarIva, diasAtrasoDe, getReglas, limiteTotal, moraDeProximaCuota, nivelPorCuotasPagadas, penalizacionAcumulada, simularCredito, totalConMora } from '../services/creditos-reglas.service';
import { enviarPush } from '../services/push.service';
import { eliminarDocumentosUsuario, rutaAbsolutaSegura } from '../services/creditos-storage.service';

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
 * crédito activo se va liberando a medida que se paga la factura (mora incluida: si se
 * atrasa, sigue comprometiendo línea de crédito hasta que también la salde); en cualquier
 * otro estado (todavía sin pago confirmado) sigue comprometido el monto completo.
 */
function montoComprometido(s: CreditoSolicitud, reglas: CreditoReglas): number {
  if (s.status === 'activo' && s.factura) {
    return Math.max(0, round(totalConMora(s, reglas) - montoPagadoDe(s)));
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
        const usado = solicitudes.filter((s) => s.usuarioId === u.id).reduce((sum, s) => sum + montoComprometido(s, reglas), 0);
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

  /** Cuentas con una solicitud de eliminación sin resolver, con aviso de si ya se pueden
   *  eliminar o si primero hay que esperar a que salden un crédito activo. */
  async listarSolicitudesEliminacion(req: Request, res: Response): Promise<void> {
    const usuarios = await database
      .getCollection<CreditoUsuario>('creditos_usuarios')
      .find({ 'solicitudEliminacion.estado': 'pendiente' })
      .sort({ 'solicitudEliminacion.solicitadaEn': 1 })
      .toArray();

    const solicitudesCollection = database.getCollection<CreditoSolicitud>('creditos_solicitudes');
    const resultado = await Promise.all(
      usuarios.map(async (u) => {
        const creditoPendiente = await solicitudesCollection.countDocuments({
          usuarioId: u.id,
          status: { $in: ['pendiente_aceptacion', 'esperando_pago', 'solicitado', 'activo'] },
        });
        return {
          id: u.id,
          nombre: u.nombre,
          telefono: u.telefono,
          email: u.email,
          motivo: u.solicitudEliminacion?.motivo,
          solicitadaEn: u.solicitudEliminacion?.solicitadaEn,
          tieneCreditoPendiente: creditoPendiente > 0,
        };
      }),
    );
    res.json(resultado);
  }

  /**
   * Anonimiza la cuenta (nombre, teléfono, email, documentos y contraseña) y la marca como
   * eliminada; no puede volver a iniciar sesión. Se conserva su historial de facturas/pagos
   * para contabilidad, ya sin datos personales asociados. Se rechaza si tiene un crédito
   * activo con saldo pendiente: primero debe saldarlo.
   */
  async aprobarEliminacion(req: Request, res: Response): Promise<void> {
    const { id } = req.params;
    const usuario = await database.getCollection<CreditoUsuario>('creditos_usuarios').findOne({ id });
    if (!usuario) {
      res.status(404).json({ error: 'Usuario no encontrado' });
      return;
    }
    if (usuario.solicitudEliminacion?.estado !== 'pendiente') {
      res.status(400).json({ error: 'Este usuario no tiene una solicitud de eliminación pendiente' });
      return;
    }

    const creditoPendiente = await database.getCollection<CreditoSolicitud>('creditos_solicitudes').countDocuments({
      usuarioId: id,
      status: { $in: ['pendiente_aceptacion', 'esperando_pago', 'solicitado', 'activo'] },
    });
    if (creditoPendiente > 0) {
      res.status(400).json({ error: 'El cliente tiene un crédito activo con saldo pendiente; no se puede eliminar la cuenta hasta que lo salde' });
      return;
    }

    eliminarDocumentosUsuario(String(id));
    await database.getCollection<CreditoUsuario>('creditos_usuarios').updateOne(
      { id },
      {
        $set: {
          nombre: 'Usuario eliminado',
          telefono: `eliminado-${id}`,
          // No es un hash real de argon2: no coincide con ninguna contraseña, así que basta
          // para bloquear el login sin necesidad de generar un hash de verdad.
          passwordHash: crypto.randomBytes(32).toString('hex'),
          eliminadoEn: new Date(),
          updatedAt: new Date(),
        },
        $unset: { email: '', verificacion: '', ultimaUbicacion: '', solicitudEliminacion: '' },
      },
    );
    res.json({ message: 'Cuenta eliminada' });
  }

  /** El staff rechaza la solicitud (normalmente porque el cliente tiene un crédito activo
   *  pendiente); la cuenta sigue igual y el cliente ve el motivo en la app. */
  async rechazarEliminacion(req: Request, res: Response): Promise<void> {
    const { id } = req.params;
    const { motivo } = req.body;
    const usuario = await database.getCollection<CreditoUsuario>('creditos_usuarios').findOne({ id });
    if (!usuario) {
      res.status(404).json({ error: 'Usuario no encontrado' });
      return;
    }
    if (usuario.solicitudEliminacion?.estado !== 'pendiente') {
      res.status(400).json({ error: 'Este usuario no tiene una solicitud de eliminación pendiente' });
      return;
    }

    await database.getCollection<CreditoUsuario>('creditos_usuarios').updateOne(
      { id },
      {
        $set: {
          'solicitudEliminacion.estado': 'rechazada',
          'solicitudEliminacion.motivoRechazo': (motivo || '').trim() || 'No especificado',
          updatedAt: new Date(),
        },
      },
    );
    res.json({ message: 'Solicitud rechazada' });
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
    const reglas = await getReglas();

    res.json(
      solicitudes.map((s) => ({
        ...s,
        usuarioNombre: usuarioPorId.get(s.usuarioId)?.nombre,
        usuarioTelefono: usuarioPorId.get(s.usuarioId)?.telefono,
        diasAtraso: diasAtrasoDe(s, reglas),
        moraProximaCuota: moraDeProximaCuota(s, reglas),
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
      // El monto que se ingresa aquí ya incluye IVA (es lo que paga el cliente); se desglosa
      // más abajo para armar la factura.
      const montoConIva = round(Number(monto));

      if (!usuarioId || !Number.isFinite(montoConIva) || montoConIva <= 0) {
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
      const usado = existentes.reduce((sum, s) => sum + montoComprometido(s, reglas), 0);
      const disponible = Math.max(0, limiteTotal(reglas, usuario) - usado);

      if (montoConIva > disponible) {
        res.status(400).json({ error: `El monto (${montoConIva}) supera el disponible del usuario (${disponible})` });
        return;
      }

      const { subtotal, iva } = desglosarIva(reglas, montoConIva);
      const sim = simularCredito(reglas, subtotal);
      const ahora = new Date();
      const numeroFactura = `F-${String((await solicitudesCollection.countDocuments({ factura: { $exists: true } })) + 1).padStart(6, '0')}`;
      const id = Date.now().toString();

      const solicitud: CreditoSolicitud = {
        id,
        usuarioId,
        monto: montoConIva,
        cuotas: reglas.cuotas,
        frecuencia: 'quincenal',
        cuotaMonto: sim.cuotaMonto,
        total: sim.total,
        proposito: 'Compra registrada en tienda',
        status: 'pendiente_aceptacion',
        cuotasPagadas: 0,
        createdAt: ahora,
        registradoPor: nombreAdmin(req),
        factura: { numero: numeroFactura, emitidaEn: ahora, subtotal, iva, total: montoConIva },
      };

      await solicitudesCollection.insertOne(solicitud);

      const qrCode = await QRCode.toDataURL(`${QR_PREFIJO}${id}`, { margin: 1, width: 320 });
      res.status(201).json({ ...solicitud, qrCode });
    } catch (error) {
      console.error('Error al registrar compra:', error);
      res.status(500).json({ error: 'Error al registrar la compra' });
    }
  }

  /**
   * Igual que registrarCompra, pero sin QR y con el pago inicial ya decidido por root (no lo
   * elige el cliente): la solicitud le llega directo a "Por confirmar" en su app con ambos
   * montos fijos, y solo puede aceptarla o rechazarla. Restringido a root (ver rutas).
   */
  async registrarCompraManual(req: Request, res: Response): Promise<void> {
    try {
      const { usuarioId, monto, pagoInicial } = req.body as { usuarioId?: string; monto?: number; pagoInicial?: number };
      // El monto que se ingresa aquí ya incluye IVA (es lo que paga el cliente); se desglosa
      // más abajo para armar la factura.
      const montoConIva = round(Number(monto));

      if (!usuarioId || !Number.isFinite(montoConIva) || montoConIva <= 0) {
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
      const usado = existentes.reduce((sum, s) => sum + montoComprometido(s, reglas), 0);
      const disponible = Math.max(0, limiteTotal(reglas, usuario) - usado);

      if (montoConIva > disponible) {
        res.status(400).json({ error: `El monto (${montoConIva}) supera el disponible del usuario (${disponible})` });
        return;
      }

      const { subtotal, iva } = desglosarIva(reglas, montoConIva);
      const inicial = round(Number(pagoInicial));
      if (!Number.isFinite(inicial) || inicial < iva - 0.01 || inicial > montoConIva + 0.01) {
        res.status(400).json({ error: `El pago inicial debe estar entre ${iva} y ${montoConIva}` });
        return;
      }

      const sim = simularCredito(reglas, subtotal);
      const ahora = new Date();
      const numeroFactura = `F-${String((await solicitudesCollection.countDocuments({ factura: { $exists: true } })) + 1).padStart(6, '0')}`;
      const id = Date.now().toString();

      const solicitud: CreditoSolicitud = {
        id,
        usuarioId,
        monto: montoConIva,
        cuotas: reglas.cuotas,
        frecuencia: 'quincenal',
        cuotaMonto: sim.cuotaMonto,
        total: sim.total,
        proposito: 'Compra asignada por administración',
        status: 'pendiente_aceptacion',
        pagoInicialAsignado: inicial,
        cuotasPagadas: 0,
        createdAt: ahora,
        registradoPor: nombreAdmin(req),
        factura: { numero: numeroFactura, emitidaEn: ahora, subtotal, iva, total: montoConIva },
      };

      await solicitudesCollection.insertOne(solicitud);
      void enviarPush(usuarioId, 'Tienes una compra por confirmar', `Revísala en "Por confirmar" y acéptala o recházala.`, '/tabs/compras');
      res.status(201).json(solicitud);
    } catch (error) {
      console.error('Error al asignar compra:', error);
      res.status(500).json({ error: 'Error al asignar la compra' });
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

    const reglas = await getReglas();
    const montoPagado = round(montoPagadoDe(solicitud) + pago.monto);
    // Mora calculada sobre lo que se debía antes de este abono: lo que ya estaba vencido no
    // deja de contar solo porque ahora está pagando.
    const totalAPagar = totalConMora(solicitud, reglas);
    const nuevoStatus: CreditoSolicitudStatus = montoPagado >= totalAPagar - 0.01 ? 'pagado' : 'activo';
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

  /**
   * Cobro en efectivo de la próxima cuota: a diferencia de crearPago/verificarPago (Pago
   * Móvil o transferencia, con un monto declarado), acá el staff no escribe un monto —
   * se asume que cobró la cuota completa más la mora que tenga acumulada esa cuota puntual.
   */
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

    const reglas = await getReglas();
    const mora = moraDeProximaCuota(solicitud, reglas);
    const montoCobrado = round(solicitud.cuotaMonto + mora);
    const montoPagado = round(montoPagadoDe(solicitud) + montoCobrado);
    const cuotasPagadas = solicitud.cuotasPagadas + 1;
    const nuevoStatus: CreditoSolicitudStatus = cuotasPagadas >= solicitud.cuotas ? 'pagado' : 'activo';

    await Promise.all([
      database
        .getCollection<CreditoSolicitud>('creditos_solicitudes')
        .updateOne({ id }, { $set: { cuotasPagadas, montoPagado, status: nuevoStatus } }),
      acreditarCuotasPagadas(solicitud.usuarioId, 1),
    ]);

    res.json({ message: 'Pago registrado', cuotasPagadas, montoPagado, montoCobrado, mora, status: nuevoStatus });
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

  /** Clientes sin email que pidieron "olvidé mi contraseña": hay que llamarlos y
   *  restablecérsela a mano desde acá. */
  async listarSolicitudesRestablecimiento(_req: Request, res: Response): Promise<void> {
    const usuarios = await database
      .getCollection<CreditoUsuario>('creditos_usuarios')
      .find({ 'solicitudRestablecimiento.solicitadaEn': { $exists: true } })
      .sort({ 'solicitudRestablecimiento.solicitadaEn': 1 })
      .toArray();
    res.json(usuarios.map((u) => ({
      id: u.id,
      nombre: u.nombre,
      telefono: u.telefono,
      solicitadaEn: u.solicitudRestablecimiento?.solicitadaEn,
    })));
  }

  /** Genera una contraseña temporal y se la muestra al staff una sola vez, para que se la
   *  dicte al cliente por teléfono (o lo que use la tienda para verificar identidad). */
  async restablecerPassword(req: Request, res: Response): Promise<void> {
    const { id } = req.params;
    const usuario = await database.getCollection<CreditoUsuario>('creditos_usuarios').findOne({ id });
    if (!usuario) {
      res.status(404).json({ error: 'Usuario no encontrado' });
      return;
    }

    const temporal = crypto.randomBytes(4).toString('hex');
    const passwordHash = await argon2.hash(temporal, {
      type: argon2.argon2id,
      memoryCost: 65536,
      timeCost: 3,
      parallelism: 4,
    });

    await database.getCollection<CreditoUsuario>('creditos_usuarios').updateOne(
      { id },
      { $set: { passwordHash, updatedAt: new Date() }, $unset: { solicitudRestablecimiento: '' } },
    );
    res.json({ passwordTemporal: temporal });
  }

  /**
   * Resumen para el panel de Reportes: cuánto crédito se ha movido, cuánto está pendiente de
   * cobro, mora, distribución por nivel y el estado del Centro de Ayuda. Todo calculado al
   * vuelo con lo que ya hay en las colecciones (no hay una tabla de reportes aparte).
   */
  async reportes(_req: Request, res: Response): Promise<void> {
    const [usuarios, solicitudes, tickets] = await Promise.all([
      database.getCollection<CreditoUsuario>('creditos_usuarios').find({}).toArray(),
      database.getCollection<CreditoSolicitud>('creditos_solicitudes').find({}).toArray(),
      database.getCollection<CreditoTicket>('creditos_tickets').find({}).toArray(),
    ]);
    const reglas = await getReglas();

    const usuariosVerificados = usuarios.filter((u) => u.status === 'verificado' && !u.eliminadoEn).length;

    const porEstado: Record<string, { cantidad: number; monto: number }> = {};
    for (const s of solicitudes) {
      const key = s.status;
      if (!porEstado[key]) porEstado[key] = { cantidad: 0, monto: 0 };
      porEstado[key].cantidad += 1;
      porEstado[key].monto += s.factura?.total ?? s.monto;
    }

    const activas = solicitudes.filter((s) => s.status === 'activo');
    const pagadas = solicitudes.filter((s) => s.status === 'pagado');
    const totalOtorgado = [...activas, ...pagadas].reduce((sum, s) => sum + (s.factura?.total ?? s.monto), 0);
    const saldoPendienteActivos = activas.reduce((sum, s) => sum + montoComprometido(s, reglas), 0);

    const atrasadas = activas
      .map((s) => ({ s, dias: diasAtrasoDe(s, reglas) }))
      .filter((x) => x.dias > 0);
    const atrasadasMas7 = atrasadas.filter((x) => x.dias > 7);
    const moraAcumuladaTotal = activas.reduce((sum, s) => sum + penalizacionAcumulada(s, reglas), 0);

    const porNivel: Record<number, number> = {};
    for (const u of usuarios) {
      if (u.eliminadoEn) continue;
      porNivel[u.nivel] = (porNivel[u.nivel] ?? 0) + 1;
    }

    const ticketsPorEstado = { abierto: 0, en_proceso: 0, cerrado: 0 };
    let ticketsPagoAtrasado = 0;
    for (const t of tickets) {
      ticketsPorEstado[t.estado] += 1;
      if (t.tipo === 'pago_atrasado') ticketsPagoAtrasado += 1;
    }

    res.json({
      usuarios: { total: usuarios.filter((u) => !u.eliminadoEn).length, verificados: usuariosVerificados },
      credito: {
        totalOtorgado: round(totalOtorgado),
        saldoPendienteActivos: round(saldoPendienteActivos),
        clientesActivos: activas.length,
        clientesConMora: atrasadas.length,
        clientesConMoraGrave: atrasadasMas7.length,
        montoEnMoraGrave: round(atrasadasMas7.reduce((sum, x) => sum + montoComprometido(x.s, reglas), 0)),
        moraAcumuladaTotal: round(moraAcumuladaTotal),
      },
      porEstado,
      porNivel,
      tickets: { ...ticketsPorEstado, pagoAtrasado: ticketsPagoAtrasado },
    });
  }

  // ---------- Centro de ayuda ----------

  /** Todos los tickets, con nombre/teléfono del cliente y sus días de atraso (si el ticket
   *  viene de una compra puntual) para que el panel pueda resaltarlos. */
  async listarTickets(req: Request, res: Response): Promise<void> {
    const estado = req.query.estado as CreditoTicketEstado | undefined;
    const filtro: Record<string, unknown> = {};
    if (estado) filtro.estado = estado;

    const tickets = await database
      .getCollection<CreditoTicket>('creditos_tickets')
      .find(filtro)
      .sort({ actualizadoEn: -1 })
      .toArray();

    const usuarioIds = [...new Set(tickets.map((t) => t.usuarioId))];
    const usuarios = await database.getCollection<CreditoUsuario>('creditos_usuarios').find({ id: { $in: usuarioIds } }).toArray();
    const usuarioPorId = new Map(usuarios.map((u) => [u.id, u]));

    const solicitudIds = [...new Set(tickets.map((t) => t.solicitudId).filter((id): id is string => !!id))];
    const reglas = await getReglas();
    const solicitudes = solicitudIds.length
      ? await database.getCollection<CreditoSolicitud>('creditos_solicitudes').find({ id: { $in: solicitudIds } }).toArray()
      : [];
    const diasAtrasoPorSolicitud = new Map(solicitudes.map((s) => [s.id, diasAtrasoDe(s, reglas)]));

    res.json(
      tickets.map((t) => ({
        ...t,
        usuarioNombre: usuarioPorId.get(t.usuarioId)?.nombre,
        usuarioTelefono: usuarioPorId.get(t.usuarioId)?.telefono,
        diasAtraso: t.solicitudId ? diasAtrasoPorSolicitud.get(t.solicitudId) ?? 0 : 0,
      })),
    );
  }

  async obtenerTicket(req: Request, res: Response): Promise<void> {
    const { id } = req.params;
    const ticket = await database.getCollection<CreditoTicket>('creditos_tickets').findOne({ id });
    if (!ticket) {
      res.status(404).json({ error: 'Ticket no encontrado' });
      return;
    }
    res.json(ticket);
  }

  async responderTicket(req: Request, res: Response): Promise<void> {
    const { id } = req.params;
    const { mensaje } = req.body;
    if (!mensaje?.trim()) {
      res.status(400).json({ error: 'Escribe un mensaje' });
      return;
    }

    const ticket = await database.getCollection<CreditoTicket>('creditos_tickets').findOne({ id });
    if (!ticket) {
      res.status(404).json({ error: 'Ticket no encontrado' });
      return;
    }

    const ahora = new Date();
    await database.getCollection<CreditoTicket>('creditos_tickets').updateOne(
      { id },
      {
        $push: { mensajes: { autor: 'staff', autorNombre: nombreAdmin(req), texto: mensaje.trim(), createdAt: ahora } },
        $set: { estado: 'en_proceso', actualizadoEn: ahora },
      },
    );
    void enviarPush(ticket.usuarioId, 'Te respondieron en Centro de Ayuda', mensaje.trim(), `/ayuda/${ticket.id}`);
    res.json({ message: 'Mensaje enviado' });
  }

  async cerrarTicket(req: Request, res: Response): Promise<void> {
    const { id } = req.params;
    const ticket = await database.getCollection<CreditoTicket>('creditos_tickets').findOne({ id });
    if (!ticket) {
      res.status(404).json({ error: 'Ticket no encontrado' });
      return;
    }
    const ahora = new Date();
    await database
      .getCollection<CreditoTicket>('creditos_tickets')
      .updateOne({ id }, { $set: { estado: 'cerrado', actualizadoEn: ahora, cerradoEn: ahora } });
    res.json({ message: 'Ticket cerrado' });
  }

  /** El staff abre un caso de pago atrasado contra una compra activa con más de 7 días de
   *  atraso (ver diasAtrasoDe). Queda como un ticket normal, tipeado para distinguirlo. */
  async abrirCasoPagoAtrasado(req: Request, res: Response): Promise<void> {
    const { solicitudId } = req.body;
    const solicitud = await database.getCollection<CreditoSolicitud>('creditos_solicitudes').findOne({ id: solicitudId });
    if (!solicitud) {
      res.status(404).json({ error: 'Compra no encontrada' });
      return;
    }

    const reglas = await getReglas();
    const diasAtraso = diasAtrasoDe(solicitud, reglas);
    if (diasAtraso <= 7) {
      res.status(400).json({ error: 'Esta compra no tiene más de 7 días de atraso' });
      return;
    }

    const yaExiste = await database.getCollection<CreditoTicket>('creditos_tickets').countDocuments({
      solicitudId,
      tipo: 'pago_atrasado',
      estado: { $ne: 'cerrado' },
    });
    if (yaExiste > 0) {
      res.status(400).json({ error: 'Ya hay un caso abierto para esta compra' });
      return;
    }

    const ahora = new Date();
    const admin = nombreAdmin(req);
    const ticket: CreditoTicket = {
      id: Date.now().toString(),
      usuarioId: solicitud.usuarioId,
      solicitudId,
      tipo: 'pago_atrasado',
      asunto: `Pago atrasado (${diasAtraso} días) — Factura ${solicitud.factura?.numero ?? solicitud.id}`,
      estado: 'abierto',
      creadoPor: 'staff',
      mensajes: [{
        autor: 'staff',
        autorNombre: admin,
        texto: `Tu cuota lleva ${diasAtraso} días de atraso. Escríbenos aquí para ponernos de acuerdo en cómo ponerte al día.`,
        createdAt: ahora,
      }],
      createdAt: ahora,
      actualizadoEn: ahora,
    };
    await database.getCollection<CreditoTicket>('creditos_tickets').insertOne(ticket);
    void enviarPush(ticket.usuarioId, 'Tienes un pago atrasado', ticket.mensajes[0].texto, `/ayuda/${ticket.id}`);
    res.status(201).json(ticket);
  }
}

export const creditosAdminController = new CreditosAdminController();
