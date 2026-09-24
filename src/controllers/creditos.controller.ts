import { Response } from 'express';
import argon2 from 'argon2';
import {
  CREDITO_DOCUMENTOS,
  CreditoDocumentoCampo,
  CreditoMetodoPago,
  CreditoPago,
  CreditoProducto,
  CreditoSolicitud,
  CreditoUsuario,
} from '../models';
import { database } from '../config/database';
import { jwtConfig } from '../config/jwt';
import { CreditoAuthRequest } from '../middlewares/creditos.middleware';
import { calcularIva, getReglas, limitePorNivel, simularCredito } from '../services/creditos-reglas.service';
import { guardarDocumento, rutaAbsolutaSegura } from '../services/creditos-storage.service';
import fs from 'fs';

function normalizarTelefono(telefono: string): string {
  return telefono.replace(/\D/g, '');
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Cuánto se ha pagado de la factura hasta ahora (con respaldo para créditos activados
 *  antes de que existiera este campo). */
function montoPagadoDe(s: CreditoSolicitud): number {
  return s.montoPagado ?? s.pagoInicial ?? s.factura?.iva ?? 0;
}

function saldoPendienteDe(s: CreditoSolicitud): number {
  const total = s.factura?.total ?? s.total;
  return Math.max(0, round(total - montoPagadoDe(s)));
}

/**
 * Lat/lng que la app reporta en momentos puntuales (aceptar una compra, declarar un pago)
 * para verificar presencia. `null` si faltan o son inválidos, para que el caller responda
 * el 400 con su propio mensaje.
 */
function extraerUbicacion(body: any): { lat: number; lng: number } | null {
  const lat = Number(body?.lat);
  const lng = Number(body?.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
    return null;
  }
  return { lat, lng };
}

function sinPassword(usuario: CreditoUsuario) {
  const { passwordHash: _passwordHash, ...resto } = usuario;
  return resto;
}

function emitirSesion(usuario: CreditoUsuario) {
  const tokens = jwtConfig.generateTokens({
    userId: usuario.id,
    email: usuario.email || '',
    rol: 'cliente_creditos',
    nombre: usuario.nombre,
  });
  return { ...sinPassword(usuario), accessToken: tokens.accessToken, refreshToken: tokens.refreshToken };
}

export class CreditosController {
  async register(req: CreditoAuthRequest, res: Response): Promise<void> {
    try {
      const { nombre, telefono, password } = req.body;
      if (!nombre?.trim() || !telefono || !password) {
        res.status(400).json({ error: 'Nombre, teléfono y contraseña son requeridos' });
        return;
      }
      if (password.length < 6) {
        res.status(400).json({ error: 'La contraseña debe tener al menos 6 caracteres' });
        return;
      }

      const tel = normalizarTelefono(telefono);
      if (tel.length < 7) {
        res.status(400).json({ error: 'Ingresa un teléfono válido' });
        return;
      }

      const coleccion = database.getCollection<CreditoUsuario>('creditos_usuarios');
      const existente = await coleccion.findOne({ telefono: tel });
      if (existente) {
        res.status(400).json({ error: 'Ya existe una cuenta con ese teléfono' });
        return;
      }

      // Verificación puntual de presencia: sin ubicación no se completa el registro.
      const ubicacion = extraerUbicacion(req.body);
      if (!ubicacion) {
        res.status(400).json({ error: 'Activa la ubicación de tu teléfono para continuar' });
        return;
      }

      const passwordHash = await argon2.hash(password, {
        type: argon2.argon2id,
        memoryCost: 65536,
        timeCost: 3,
        parallelism: 4,
      });

      const ahora = new Date();
      const usuario: CreditoUsuario = {
        id: Date.now().toString(),
        nombre: nombre.trim(),
        telefono: tel,
        passwordHash,
        nivel: 1,
        status: 'sin_verificar',
        tutorialVisto: false,
        ultimaUbicacion: { ...ubicacion, actualizadaEn: ahora },
        createdAt: ahora,
        updatedAt: ahora,
      };
      await coleccion.insertOne(usuario);

      res.status(201).json(emitirSesion(usuario));
    } catch (error) {
      console.error('Error en registro de créditos:', error);
      res.status(500).json({ error: 'Error al registrar usuario' });
    }
  }

  async login(req: CreditoAuthRequest, res: Response): Promise<void> {
    try {
      const { telefono, password } = req.body;
      if (!telefono || !password) {
        res.status(400).json({ error: 'Teléfono y contraseña son requeridos' });
        return;
      }

      const tel = normalizarTelefono(telefono);
      const usuario = await database.getCollection<CreditoUsuario>('creditos_usuarios').findOne({ telefono: tel });
      if (!usuario || !(await argon2.verify(usuario.passwordHash, password))) {
        res.status(401).json({ error: 'Teléfono o contraseña incorrectos' });
        return;
      }

      // Verificación puntual de presencia: sin ubicación no se completa el inicio de sesión.
      const ubicacion = extraerUbicacion(req.body);
      if (!ubicacion) {
        res.status(400).json({ error: 'Activa la ubicación de tu teléfono para continuar' });
        return;
      }

      const ultimaUbicacion = { ...ubicacion, actualizadaEn: new Date() };
      await database
        .getCollection<CreditoUsuario>('creditos_usuarios')
        .updateOne({ id: usuario.id }, { $set: { ultimaUbicacion } });

      res.json(emitirSesion({ ...usuario, ultimaUbicacion }));
    } catch (error) {
      console.error('Error en login de créditos:', error);
      res.status(500).json({ error: 'Error al iniciar sesión' });
    }
  }

  async me(req: CreditoAuthRequest, res: Response): Promise<void> {
    const usuario = await database.getCollection<CreditoUsuario>('creditos_usuarios').findOne({ id: req.creditoUser!.userId });
    if (!usuario) {
      res.status(404).json({ error: 'Usuario no encontrado' });
      return;
    }
    res.json(sinPassword(usuario));
  }

  async actualizarEmail(req: CreditoAuthRequest, res: Response): Promise<void> {
    try {
      const { email } = req.body;
      if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        res.status(400).json({ error: 'Ingresa un email válido' });
        return;
      }
      await database
        .getCollection<CreditoUsuario>('creditos_usuarios')
        .updateOne({ id: req.creditoUser!.userId }, { $set: { email: (email || '').trim(), updatedAt: new Date() } });
      res.json({ message: 'Email actualizado' });
    } catch (error) {
      res.status(500).json({ error: 'Error al actualizar email' });
    }
  }

  async marcarTutorialVisto(req: CreditoAuthRequest, res: Response): Promise<void> {
    await database
      .getCollection<CreditoUsuario>('creditos_usuarios')
      .updateOne({ id: req.creditoUser!.userId }, { $set: { tutorialVisto: true, updatedAt: new Date() } });
    res.json({ message: 'Tutorial marcado como visto' });
  }

  async reglas(_req: CreditoAuthRequest, res: Response): Promise<void> {
    const reglas = await getReglas();
    res.json(reglas);
  }

  async productos(_req: CreditoAuthRequest, res: Response): Promise<void> {
    const productos = await database
      .getCollection<CreditoProducto>('creditos_productos')
      .find({ activo: true })
      .sort({ nombre: 1 })
      .toArray();
    res.json(productos);
  }

  async enviarVerificacion(req: CreditoAuthRequest, res: Response): Promise<void> {
    try {
      const usuarioId = req.creditoUser!.userId;
      const usuario = await database.getCollection<CreditoUsuario>('creditos_usuarios').findOne({ id: usuarioId });
      if (!usuario) {
        res.status(404).json({ error: 'Usuario no encontrado' });
        return;
      }
      if (usuario.status === 'en_revision' || usuario.status === 'verificado') {
        res.status(400).json({ error: 'Tu cuenta ya fue enviada a revisión o ya está verificada' });
        return;
      }

      const {
        nombreCompleto,
        documento,
        fechaNacimiento,
        direccion,
        ciudad,
        referenciaNombre,
        referenciaTelefono,
        ocupacion,
        lugarTrabajo,
      } = req.body;

      if (!nombreCompleto?.trim() || !documento?.trim() || !fechaNacimiento || !direccion?.trim() || !ciudad?.trim()) {
        res.status(400).json({ error: 'Faltan datos personales' });
        return;
      }

      const archivos = (req.files as Record<string, Express.Multer.File[]> | undefined) || {};
      const documentos: Partial<Record<CreditoDocumentoCampo, ReturnType<typeof guardarDocumento>>> = {};
      for (const campo of CREDITO_DOCUMENTOS) {
        const archivo = archivos[campo]?.[0];
        if (!archivo) continue;
        documentos[campo] = guardarDocumento(usuarioId, campo, archivo);
      }

      const faltantes = CREDITO_DOCUMENTOS.filter((campo) => !documentos[campo]);
      if (faltantes.length > 0) {
        res.status(400).json({ error: 'Faltan documentos por adjuntar', faltantes });
        return;
      }

      await database.getCollection<CreditoUsuario>('creditos_usuarios').updateOne(
        { id: usuarioId },
        {
          $set: {
            status: 'en_revision',
            updatedAt: new Date(),
            verificacion: {
              nombreCompleto: nombreCompleto.trim(),
              documento: documento.trim(),
              fechaNacimiento,
              direccion: direccion.trim(),
              ciudad: ciudad.trim(),
              referenciaNombre: (referenciaNombre || '').trim(),
              referenciaTelefono: (referenciaTelefono || '').trim(),
              ocupacion: (ocupacion || '').trim(),
              lugarTrabajo: (lugarTrabajo || '').trim(),
              documentos,
              enviadoEn: new Date(),
            },
          },
        },
      );

      res.json({ message: 'Verificación enviada' });
    } catch (error) {
      console.error('Error al enviar verificación:', error);
      res.status(500).json({ error: 'Error al enviar la verificación' });
    }
  }

  async documentoPropio(req: CreditoAuthRequest, res: Response): Promise<void> {
    const campo = req.params.campo as CreditoDocumentoCampo;
    const usuario = await database
      .getCollection<CreditoUsuario>('creditos_usuarios')
      .findOne({ id: req.creditoUser!.userId });

    const archivo = usuario?.verificacion?.documentos?.[campo];
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

  async listarSolicitudes(req: CreditoAuthRequest, res: Response): Promise<void> {
    const solicitudes = await database
      .getCollection<CreditoSolicitud>('creditos_solicitudes')
      .find({ usuarioId: req.creditoUser!.userId })
      .sort({ createdAt: -1 })
      .toArray();
    res.json(solicitudes);
  }

  async crearSolicitud(req: CreditoAuthRequest, res: Response): Promise<void> {
    try {
      const usuarioId = req.creditoUser!.userId;
      const usuario = await database.getCollection<CreditoUsuario>('creditos_usuarios').findOne({ id: usuarioId });
      if (!usuario || usuario.status !== 'verificado') {
        res.status(403).json({ error: 'Debes verificar tu cuenta' });
        return;
      }

      const { monto, proposito, productoId } = req.body;
      const montoNum = Number(monto);
      if (!Number.isFinite(montoNum) || montoNum <= 0) {
        res.status(400).json({ error: 'Monto inválido' });
        return;
      }

      const reglas = await getReglas();

      let producto: CreditoProducto | null = null;
      if (productoId) {
        producto = await database.getCollection<CreditoProducto>('creditos_productos').findOne({ id: productoId, activo: true });
        if (!producto) {
          res.status(404).json({ error: 'Producto no encontrado' });
          return;
        }
      } else if (montoNum < reglas.montoMinimo) {
        res.status(400).json({ error: `El monto mínimo es ${reglas.montoMinimo}` });
        return;
      }

      const solicitudesCollection = database.getCollection<CreditoSolicitud>('creditos_solicitudes');
      const existentes = await solicitudesCollection
        .find({ usuarioId, status: { $in: ['solicitado', 'activo'] } })
        .toArray();
      const usado = existentes.reduce((sum, s) => sum + s.monto, 0);
      const disponible = Math.max(0, limitePorNivel(reglas, usuario.nivel) - usado);

      const montoFinal = producto ? producto.precio : montoNum;
      if (montoFinal > disponible) {
        res.status(400).json({ error: 'Monto fuera del disponible' });
        return;
      }

      const sim = simularCredito(reglas, montoFinal);
      const ahora = new Date();
      const solicitud: CreditoSolicitud = {
        id: Date.now().toString(),
        usuarioId,
        monto: montoFinal,
        cuotas: reglas.cuotas,
        frecuencia: 'quincenal',
        cuotaMonto: sim.cuotaMonto,
        total: sim.total,
        proposito: (proposito || producto?.nombre || '').trim(),
        status: 'solicitado',
        cuotasPagadas: 0,
        createdAt: ahora,
        ...(producto && {
          productoId: producto.id,
          productoNombre: producto.nombre,
          factura: {
            numero: `F-${String((await solicitudesCollection.countDocuments({ factura: { $exists: true } })) + 1).padStart(6, '0')}`,
            emitidaEn: ahora,
            subtotal: montoFinal,
            iva: calcularIva(reglas, montoFinal),
            total: montoFinal + calcularIva(reglas, montoFinal),
          },
        }),
      };

      await solicitudesCollection.insertOne(solicitud);
      res.status(201).json(solicitud);
    } catch (error) {
      console.error('Error al crear solicitud de crédito:', error);
      res.status(500).json({ error: 'Error al crear la solicitud' });
    }
  }

  /**
   * El cliente confirma que la compra que armó el staff está correcta y elige cuánto paga
   * de inicial (mínimo el IVA de la factura, ya calculado al 16% del subtotal). El crédito
   * todavía NO arranca: queda 'esperando_pago' hasta que el staff confirme en el panel que
   * recibió ese pago inicial (efectivo/transferencia).
   */
  async aceptarSolicitud(req: CreditoAuthRequest, res: Response): Promise<void> {
    const { id } = req.params;
    const solicitud = await database
      .getCollection<CreditoSolicitud>('creditos_solicitudes')
      .findOne({ id, usuarioId: req.creditoUser!.userId });
    if (!solicitud) {
      res.status(404).json({ error: 'Compra no encontrada' });
      return;
    }
    if (solicitud.status !== 'pendiente_aceptacion') {
      res.status(400).json({ error: 'Esta compra ya no está pendiente de aceptación' });
      return;
    }
    if (!solicitud.factura) {
      res.status(400).json({ error: 'Esta compra no tiene factura' });
      return;
    }

    const minimo = solicitud.factura.iva;
    const maximo = solicitud.factura.total;
    const pagoInicial = round(Number(req.body?.pagoInicial));
    if (!Number.isFinite(pagoInicial) || pagoInicial < minimo - 0.01 || pagoInicial > maximo + 0.01) {
      res.status(400).json({ error: `El pago inicial debe estar entre ${minimo} y ${maximo}` });
      return;
    }

    // Verificación puntual de presencia: sin ubicación no se acepta la compra.
    const ubicacion = extraerUbicacion(req.body);
    if (!ubicacion) {
      res.status(400).json({ error: 'Activa la ubicación de tu teléfono para continuar' });
      return;
    }

    const cuotaMonto = round((maximo - pagoInicial) / solicitud.cuotas);
    const usuarioId = req.creditoUser!.userId;

    await Promise.all([
      database
        .getCollection<CreditoSolicitud>('creditos_solicitudes')
        .updateOne({ id }, { $set: { status: 'esperando_pago', pagoInicial, cuotaMonto } }),
      database
        .getCollection<CreditoUsuario>('creditos_usuarios')
        .updateOne({ id: usuarioId }, { $set: { ultimaUbicacion: { ...ubicacion, actualizadaEn: new Date() } } }),
    ]);
    res.json({ message: 'Compra confirmada, falta registrar el pago inicial', pagoInicial, cuotaMonto });
  }

  /** El cliente rechaza una compra armada por el staff (por ejemplo, si algo está mal). */
  async rechazarSolicitud(req: CreditoAuthRequest, res: Response): Promise<void> {
    const { id } = req.params;
    const { motivo } = req.body;
    const solicitud = await database
      .getCollection<CreditoSolicitud>('creditos_solicitudes')
      .findOne({ id, usuarioId: req.creditoUser!.userId });
    if (!solicitud) {
      res.status(404).json({ error: 'Compra no encontrada' });
      return;
    }
    if (solicitud.status !== 'pendiente_aceptacion') {
      res.status(400).json({ error: 'Esta compra ya no está pendiente de aceptación' });
      return;
    }

    await database.getCollection<CreditoSolicitud>('creditos_solicitudes').updateOne(
      { id },
      { $set: { status: 'rechazado', motivoRechazo: (motivo || '').trim() || 'Rechazada por el cliente' } },
    );
    res.json({ message: 'Compra rechazada' });
  }

  /**
   * El cliente declara que ya pagó un abono (cuota u otro monto) por Pago Móvil o
   * Transferencia, fuera de la app. Queda pendiente de que el staff lo verifique contra el
   * banco antes de que se refleje en la factura.
   */
  async crearPago(req: CreditoAuthRequest, res: Response): Promise<void> {
    const { id } = req.params;
    const usuarioId = req.creditoUser!.userId;
    const solicitud = await database
      .getCollection<CreditoSolicitud>('creditos_solicitudes')
      .findOne({ id, usuarioId });
    if (!solicitud) {
      res.status(404).json({ error: 'Compra no encontrada' });
      return;
    }
    if (solicitud.status !== 'activo') {
      res.status(400).json({ error: 'Esta factura no está activa' });
      return;
    }

    const metodo = req.body?.metodo as CreditoMetodoPago;
    if (metodo !== 'pago_movil' && metodo !== 'transferencia') {
      res.status(400).json({ error: 'Método de pago inválido' });
      return;
    }

    const saldo = saldoPendienteDe(solicitud);
    const monto = round(Number(req.body?.monto));
    if (!Number.isFinite(monto) || monto <= 0 || monto > saldo + 0.01) {
      res.status(400).json({ error: `El monto debe ser mayor a 0 y no superar el saldo pendiente (${saldo})` });
      return;
    }

    // Verificación puntual de presencia: sin ubicación no se declara el pago.
    const ubicacion = extraerUbicacion(req.body);
    if (!ubicacion) {
      res.status(400).json({ error: 'Activa la ubicación de tu teléfono para continuar' });
      return;
    }

    const pago: CreditoPago = {
      id: Date.now().toString(),
      solicitudId: String(id),
      usuarioId,
      monto,
      metodo,
      status: 'pendiente_verificacion',
      createdAt: new Date(),
    };
    await Promise.all([
      database.getCollection<CreditoPago>('creditos_pagos').insertOne(pago),
      database
        .getCollection<CreditoUsuario>('creditos_usuarios')
        .updateOne({ id: usuarioId }, { $set: { ultimaUbicacion: { ...ubicacion, actualizadaEn: new Date() } } }),
    ]);
    res.status(201).json(pago);
  }

  /** Para que la app haga polling del estado mientras el staff verifica el pago declarado. */
  async obtenerPago(req: CreditoAuthRequest, res: Response): Promise<void> {
    const { id } = req.params;
    const pago = await database
      .getCollection<CreditoPago>('creditos_pagos')
      .findOne({ id, usuarioId: req.creditoUser!.userId });
    if (!pago) {
      res.status(404).json({ error: 'Pago no encontrado' });
      return;
    }
    res.json(pago);
  }
}

export const creditosController = new CreditosController();
