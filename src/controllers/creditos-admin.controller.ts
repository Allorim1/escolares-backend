import { Response } from 'express';
import fs from 'fs';
import { Request } from 'express';
import QRCode from 'qrcode';
import {
  CreditoDocumentoCampo,
  CreditoEstadoVerificacion,
  CreditoProducto,
  CreditoReglas,
  CreditoSolicitud,
  CreditoSolicitudStatus,
  CreditoUsuario,
} from '../models';
import { database } from '../config/database';
import { calcularIva, getReglas, limitePorNivel, simularCredito } from '../services/creditos-reglas.service';
import { rutaAbsolutaSegura } from '../services/creditos-storage.service';

/** Prefijo que identifica un QR de compra de créditos, para no confundirlo con cualquier
 *  otro código que el cliente pueda escanear por error. */
const QR_PREFIJO = 'ESCOLARES-CREDITO:';

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

function nombreAdmin(req: Request): string {
  const user = (req as any).user;
  return user?.nombre || user?.username || user?.email || 'Sistema';
}

function sinPassword(usuario: CreditoUsuario) {
  const { passwordHash: _passwordHash, ...resto } = usuario;
  return resto;
}

export class CreditosAdminController {
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
        const usado = solicitudes.filter((s) => s.usuarioId === u.id).reduce((sum, s) => sum + s.monto, 0);
        const limite = limitePorNivel(reglas, u.nivel);
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
      const usado = existentes.reduce((sum, s) => sum + s.monto, 0);
      const disponible = Math.max(0, limitePorNivel(reglas, usuario.nivel) - usado);

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

    await database.getCollection<CreditoSolicitud>('creditos_solicitudes').updateOne(
      { id },
      { $set: { status: 'activo', activadoEn: new Date(), revisadoPor: nombreAdmin(req) } },
    );
    res.json({ message: 'Pago inicial confirmado, crédito activado' });
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

    await database
      .getCollection<CreditoSolicitud>('creditos_solicitudes')
      .updateOne({ id }, { $set: { cuotasPagadas, status: nuevoStatus } });

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

    await getReglas(); // asegura que el documento exista antes de actualizarlo
    const result = await database
      .getCollection<CreditoReglas>('creditos_reglas')
      .findOneAndUpdate({ id: 'reglas' }, { $set: cambios }, { returnDocument: 'after' });
    res.json(result);
  }
}

export const creditosAdminController = new CreditosAdminController();
