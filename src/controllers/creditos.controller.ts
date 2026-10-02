import { Response } from 'express';
import argon2 from 'argon2';
import {
  CREDITO_DOCUMENTOS,
  CreditoDocumentoCampo,
  CreditoMetodoPago,
  CreditoPago,
  CreditoDatosPagoBdv,
  CreditoProducto,
  CreditoReglas,
  CreditoSolicitud,
  CreditoTicket,
  CreditoUsuario,
} from '../models';
import { database } from '../config/database';
import { jwtConfig } from '../config/jwt';
import { CreditoAuthRequest } from '../middlewares/creditos.middleware';
import { calcularIva, getReglas, limiteTotal, penalizacionAcumulada, simularCredito } from '../services/creditos-reglas.service';
import { guardarDocumento, rutaAbsolutaSegura } from '../services/creditos-storage.service';
import { avisarTicketActualizado } from '../services/tickets-realtime.service';
import { consultarPagoBdv } from '../services/bdv.service';
import { aplicarPagoVerificado } from '../services/creditos-pagos.service';
import { obtenerTasaUsdBcv } from '../services/tasa-bcv.service';
import fs from 'fs';
import nodemailer from 'nodemailer';

// Misma configuración SMTP que auth.controller.ts (transporter aparte, siguiendo la
// convención ya usada ahí y en cierre-caja.routes.ts: cada archivo arma el suyo).
const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST || 'smtp.gmail.com',
  port: parseInt(process.env.SMTP_PORT || '587'),
  secure: false,
  auth: {
    user: process.env.SMTP_USER || '',
    pass: process.env.SMTP_PASS || '',
  },
});

interface CreditoPasswordResetOtp {
  usuarioId: string;
  otp: string;
  expiresAt: Date;
  used: boolean;
}

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

/** Incluye la mora acumulada: lo que el cliente debe pagar hoy para saldar la factura, no
 *  solo el monto original. */
function saldoPendienteDe(s: CreditoSolicitud, reglas: CreditoReglas): number {
  const total = (s.factura?.total ?? s.total) + penalizacionAcumulada(s, reglas);
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

/**
 * Datos del Pago Móvil o transferencia que la app manda al declarar el pago, ya normalizados. Devuelve un
 * string con el error para el cliente si algo no cumple el formato que pide BDV.
 */
function extraerDatosPagoBdv(body: any): Omit<CreditoDatosPagoBdv, 'tasa'> | string {
  const cedulaPagador = String(body?.cedulaPagador ?? '').toUpperCase().replace(/[^VEJP0-9]/g, '');
  const telefonoPagador = String(body?.telefonoPagador ?? '').replace(/\D/g, '');
  const referencia = String(body?.referencia ?? '').replace(/\D/g, '');
  const fechaPago = String(body?.fechaPago ?? '');
  const bancoOrigen = String(body?.bancoOrigen ?? '');
  const importeBs = round(Number(body?.importeBs));

  if (!/^[VEJP]\d{5,9}$/.test(cedulaPagador)) return 'Cédula inválida';
  if (!/^04\d{9}$/.test(telefonoPagador)) return 'El teléfono debe tener 11 dígitos, p.ej. 04141234567';
  if (!/^\d{6}$/.test(referencia)) return 'La referencia debe ser los últimos 6 dígitos';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fechaPago) || Number.isNaN(Date.parse(fechaPago))) return 'Fecha de pago inválida';
  if (!/^\d{4}$/.test(bancoOrigen)) return 'Selecciona el banco desde donde pagaste';
  if (!(importeBs > 0)) return 'Monto en bolívares inválido';
  return { cedulaPagador, telefonoPagador, referencia, fechaPago, bancoOrigen, importeBs };
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
      if (usuario?.eliminadoEn) {
        res.status(401).json({ error: 'Esta cuenta fue eliminada' });
        return;
      }
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

  /**
   * El teléfono es lo único garantizado; el email es opcional. Si el cliente tiene uno
   * registrado, le mandamos un OTP igual que en auth.controller.ts. Si no, dejamos una marca
   * para que el staff lo llame y le restablezca la contraseña a mano desde el panel.
   */
  async olvidePassword(req: CreditoAuthRequest, res: Response): Promise<void> {
    try {
      const { telefono } = req.body;
      if (!telefono) {
        res.status(400).json({ error: 'Ingresa tu teléfono' });
        return;
      }

      const tel = normalizarTelefono(telefono);
      const usuario = await database.getCollection<CreditoUsuario>('creditos_usuarios').findOne({ telefono: tel });
      if (!usuario || usuario.eliminadoEn) {
        res.status(404).json({ error: 'No hay una cuenta con ese teléfono' });
        return;
      }

      if (!usuario.email) {
        await database
          .getCollection<CreditoUsuario>('creditos_usuarios')
          .updateOne({ id: usuario.id }, { $set: { solicitudRestablecimiento: { solicitadaEn: new Date() } } });
        res.json({ metodo: 'staff', message: 'No tienes un correo registrado. El equipo te va a contactar para restablecer tu contraseña.' });
        return;
      }

      const otp = Math.floor(100000 + Math.random() * 900000).toString();
      const expiresAt = new Date(Date.now() + 10 * 60 * 1000);
      await database
        .getCollection<CreditoPasswordResetOtp>('creditos_password_reset_otp')
        .updateOne({ usuarioId: usuario.id }, { $set: { otp, expiresAt, usuarioId: usuario.id, used: false } }, { upsert: true });

      if (process.env.SMTP_USER && process.env.SMTP_PASS) {
        try {
          await transporter.sendMail({
            from: process.env.SMTP_FROM || process.env.SMTP_USER,
            to: usuario.email,
            subject: 'Código de recuperación de contraseña — Escolares Online',
            html: `<h2>Recuperación de contraseña</h2><p>Tu código de verificación es: <strong>${otp}</strong></p><p>Este código expira en 10 minutos.</p>`,
          });
        } catch (emailError) {
          console.error('Error enviando OTP de créditos:', emailError);
        }
      } else {
        console.log(`OTP créditos para ${usuario.email}: ${otp}`);
      }

      const emailOculto = usuario.email.replace(/^(.{2}).*(@.*)$/, '$1***$2');
      res.json({ metodo: 'email', message: 'Te enviamos un código a tu correo', email: emailOculto });
    } catch (error) {
      console.error('Error en olvidePassword:', error);
      res.status(500).json({ error: 'Error al procesar la solicitud' });
    }
  }

  async verificarOtpYRestablecer(req: CreditoAuthRequest, res: Response): Promise<void> {
    try {
      const { telefono, otp, nuevaPassword } = req.body;
      if (!telefono || !otp || !nuevaPassword) {
        res.status(400).json({ error: 'Teléfono, código y nueva contraseña son requeridos' });
        return;
      }
      if (nuevaPassword.length < 6) {
        res.status(400).json({ error: 'La contraseña debe tener al menos 6 caracteres' });
        return;
      }

      const tel = normalizarTelefono(telefono);
      const usuario = await database.getCollection<CreditoUsuario>('creditos_usuarios').findOne({ telefono: tel });
      if (!usuario) {
        res.status(404).json({ error: 'No hay una cuenta con ese teléfono' });
        return;
      }

      const registro = await database
        .getCollection<CreditoPasswordResetOtp>('creditos_password_reset_otp')
        .findOne({ usuarioId: usuario.id });
      if (!registro || registro.used) {
        res.status(400).json({ error: 'Solicita un código nuevo' });
        return;
      }
      if (new Date() > registro.expiresAt) {
        res.status(400).json({ error: 'El código expiró, solicita uno nuevo' });
        return;
      }
      if (registro.otp !== otp) {
        res.status(400).json({ error: 'Código incorrecto' });
        return;
      }

      const passwordHash = await argon2.hash(nuevaPassword, {
        type: argon2.argon2id,
        memoryCost: 65536,
        timeCost: 3,
        parallelism: 4,
      });
      await database.getCollection<CreditoUsuario>('creditos_usuarios').updateOne({ id: usuario.id }, { $set: { passwordHash, updatedAt: new Date() } });
      await database
        .getCollection<CreditoPasswordResetOtp>('creditos_password_reset_otp')
        .updateOne({ usuarioId: usuario.id }, { $set: { used: true } });

      res.json({ message: 'Contraseña actualizada' });
    } catch (error) {
      console.error('Error en verificarOtpYRestablecer:', error);
      res.status(500).json({ error: 'Error al restablecer la contraseña' });
    }
  }

  /** Guarda el token FCM del dispositivo para poder mandarle notificaciones push. Un mismo
   *  usuario puede tener varios (varios teléfonos con sesión iniciada). */
  async registrarPushToken(req: CreditoAuthRequest, res: Response): Promise<void> {
    const { token } = req.body;
    if (!token) {
      res.status(400).json({ error: 'Falta el token' });
      return;
    }
    await database
      .getCollection<CreditoUsuario>('creditos_usuarios')
      .updateOne({ id: req.creditoUser!.userId }, { $addToSet: { pushTokens: token } });
    res.json({ message: 'Token registrado' });
  }

  /** Cambio de contraseña estando ya autenticado, desde Perfil. */
  async cambiarPassword(req: CreditoAuthRequest, res: Response): Promise<void> {
    try {
      const { actual, nueva } = req.body;
      if (!actual || !nueva) {
        res.status(400).json({ error: 'Escribe tu contraseña actual y la nueva' });
        return;
      }
      if (nueva.length < 6) {
        res.status(400).json({ error: 'La nueva contraseña debe tener al menos 6 caracteres' });
        return;
      }

      const usuario = await database.getCollection<CreditoUsuario>('creditos_usuarios').findOne({ id: req.creditoUser!.userId });
      if (!usuario || !(await argon2.verify(usuario.passwordHash, actual))) {
        res.status(401).json({ error: 'La contraseña actual no es correcta' });
        return;
      }

      const passwordHash = await argon2.hash(nueva, {
        type: argon2.argon2id,
        memoryCost: 65536,
        timeCost: 3,
        parallelism: 4,
      });
      await database.getCollection<CreditoUsuario>('creditos_usuarios').updateOne({ id: usuario.id }, { $set: { passwordHash, updatedAt: new Date() } });
      res.json({ message: 'Contraseña actualizada' });
    } catch (error) {
      console.error('Error en cambiarPassword:', error);
      res.status(500).json({ error: 'Error al cambiar la contraseña' });
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
      const disponible = Math.max(0, limiteTotal(reglas, usuario) - usado);

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
   * recibió ese pago inicial (efectivo/transferencia). Excepción: si la compra la asignó
   * root a mano (pagoInicialAsignado), ese inicial ya se da por pagado y el crédito arranca
   * de una vez, sin pasar por 'esperando_pago'.
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

    // Si root armó la compra a mano con un inicial ya fijo, se usa ese monto tal cual
    // (el cliente no puede pedir otro desde el body); si no, elige entre el mínimo y el total.
    let pagoInicial: number;
    if (solicitud.pagoInicialAsignado != null) {
      pagoInicial = solicitud.pagoInicialAsignado;
    } else {
      pagoInicial = round(Number(req.body?.pagoInicial));
      if (!Number.isFinite(pagoInicial) || pagoInicial < minimo - 0.01 || pagoInicial > maximo + 0.01) {
        res.status(400).json({ error: `El pago inicial debe estar entre ${minimo} y ${maximo}` });
        return;
      }
    }

    // Verificación puntual de presencia: sin ubicación no se acepta la compra.
    const ubicacion = extraerUbicacion(req.body);
    if (!ubicacion) {
      res.status(400).json({ error: 'Activa la ubicación de tu teléfono para continuar' });
      return;
    }

    const cuotaMonto = round((maximo - pagoInicial) / solicitud.cuotas);
    const usuarioId = req.creditoUser!.userId;

    // El inicial asignado por root ya se dio por pagado al armar la compra (se resta de una
    // vez de la factura): el crédito arranca al aceptar, sin pasar por 'esperando_pago' ni por
    // que el staff confirme un cobro que nunca va a ocurrir.
    const solicitudUpdate = solicitud.pagoInicialAsignado != null
      ? { status: 'activo' as const, pagoInicial, cuotaMonto, montoPagado: pagoInicial, activadoEn: new Date() }
      : { status: 'esperando_pago' as const, pagoInicial, cuotaMonto };

    await Promise.all([
      database
        .getCollection<CreditoSolicitud>('creditos_solicitudes')
        .updateOne({ id }, { $set: solicitudUpdate }),
      database
        .getCollection<CreditoUsuario>('creditos_usuarios')
        .updateOne({ id: usuarioId }, { $set: { ultimaUbicacion: { ...ubicacion, actualizadaEn: new Date() } } }),
    ]);

    const mensaje = solicitud.pagoInicialAsignado != null
      ? 'Compra confirmada, crédito activado'
      : 'Compra confirmada, falta registrar el pago inicial';
    res.json({ message: mensaje, pagoInicial, cuotaMonto, status: solicitudUpdate.status });
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

    const reglas = await getReglas();
    const saldo = saldoPendienteDe(solicitud, reglas);
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

    // Pago Móvil con datos (app nueva): se verifica en el momento contra BDV. Sin datos
    // (versiones viejas de la app, o transferencia) sigue el flujo de verificación manual.
    let datosPago: CreditoDatosPagoBdv | undefined;
    if (metodo === 'pago_movil' && req.body?.datosPago) {
      const datos = extraerDatosPagoBdv(req.body.datosPago);
      if (typeof datos === 'string') {
        res.status(400).json({ error: datos });
        return;
      }

      // Los Bs pagados tienen que corresponder a los $ que se van a abonar. Margen del 3%
      // por si pagó otro día con una tasa un poco distinta; pagar de más no es problema.
      let tasa: number;
      try {
        tasa = await obtenerTasaUsdBcv();
      } catch {
        res.status(503).json({ error: 'No pudimos obtener la tasa del dólar. Intenta de nuevo en unos minutos.' });
        return;
      }
      if (datos.importeBs < monto * tasa * 0.97) {
        res.status(400).json({ error: 'El monto en bolívares no corresponde al monto a pagar. Revisa la tasa e intenta de nuevo.' });
        return;
      }

      const repetido = await database.getCollection<CreditoPago>('creditos_pagos').findOne({
        'datosPago.referencia': datos.referencia,
        'datosPago.fechaPago': datos.fechaPago,
        'datosPago.bancoOrigen': datos.bancoOrigen,
        status: { $ne: 'rechazado' },
      });
      if (repetido) {
        res.status(400).json({ error: 'Este pago ya fue registrado anteriormente.' });
        return;
      }
      datosPago = { ...datos, tasa };
    }

    const pago: CreditoPago = {
      id: Date.now().toString(),
      solicitudId: String(id),
      usuarioId,
      monto,
      metodo,
      status: 'pendiente_verificacion',
      createdAt: new Date(),
      ...(datosPago ? { datosPago } : {}),
    };
    // Se guarda ANTES de consultar a BDV: el banco marca el movimiento como conciliado en la
    // primera consulta, así que si algo fallara después, el pago queda pendiente para que el
    // staff lo verifique a mano en vez de perderse.
    await Promise.all([
      database.getCollection<CreditoPago>('creditos_pagos').insertOne(pago),
      database
        .getCollection<CreditoUsuario>('creditos_usuarios')
        .updateOne({ id: usuarioId }, { $set: { ultimaUbicacion: { ...ubicacion, actualizadaEn: new Date() } } }),
    ]);

    if (!datosPago) {
      res.status(201).json(pago);
      return;
    }

    let resultado: Awaited<ReturnType<typeof consultarPagoBdv>>;
    try {
      resultado = await consultarPagoBdv({
        cedulaPagador: datosPago.cedulaPagador,
        telefonoPagador: datosPago.telefonoPagador,
        referencia: datosPago.referencia,
        fechaPago: datosPago.fechaPago,
        importe: datosPago.importeBs.toFixed(2),
        bancoOrigen: datosPago.bancoOrigen,
      });
    } catch (error) {
      // No se sabe si el banco llegó a conciliarlo: queda pendiente para el staff y la app
      // hace polling como en el flujo manual.
      console.error('Error consultando BDV:', error);
      res.status(201).json(pago);
      return;
    }

    if (!resultado.valido) {
      // Datos que no corresponden a un pago (o un pago ya usado): no se registra nada y el
      // cliente puede corregir y volver a intentar.
      await database.getCollection<CreditoPago>('creditos_pagos').deleteOne({ id: pago.id });
      res.status(400).json({
        error: resultado.yaConciliado
          ? 'Este pago ya fue registrado anteriormente. Si crees que es un error, escríbenos por el Centro de ayuda.'
          : `No encontramos el pago en Banco de Venezuela. Revisa los datos e intenta de nuevo. (${resultado.mensaje})`,
      });
      return;
    }

    try {
      await aplicarPagoVerificado(pago, solicitud, 'BDV (automático)');
      res.status(201).json({ ...pago, status: 'verificado' });
    } catch (error) {
      // El banco ya lo confirmó: queda pendiente con sus datos para que el staff lo apruebe.
      console.error('Pago confirmado por BDV pero no se pudo aplicar:', error);
      res.status(201).json(pago);
    }
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

  /**
   * El cliente pide que se elimine su cuenta. No se borra de una vez: el staff la revisa
   * (ver creditos-admin.controller.ts) y solo la aprueba si no tiene un crédito activo con
   * saldo pendiente. Volver a llamar esto reemplaza una solicitud ya rechazada.
   */
  async solicitarEliminacion(req: CreditoAuthRequest, res: Response): Promise<void> {
    const { motivo } = req.body;
    await database.getCollection<CreditoUsuario>('creditos_usuarios').updateOne(
      { id: req.creditoUser!.userId },
      {
        $set: {
          solicitudEliminacion: {
            motivo: (motivo || '').trim() || undefined,
            solicitadaEn: new Date(),
            estado: 'pendiente',
          },
          updatedAt: new Date(),
        },
      },
    );
    res.json({ message: 'Solicitud enviada' });
  }

  /** El cliente cancela su propia solicitud (por ejemplo, si cambió de opinión). */
  async cancelarSolicitudEliminacion(req: CreditoAuthRequest, res: Response): Promise<void> {
    await database
      .getCollection<CreditoUsuario>('creditos_usuarios')
      .updateOne({ id: req.creditoUser!.userId }, { $unset: { solicitudEliminacion: '' } });
    res.json({ message: 'Solicitud cancelada' });
  }

  // ---------- Centro de ayuda ----------

  async listarTickets(req: CreditoAuthRequest, res: Response): Promise<void> {
    const tickets = await database
      .getCollection<CreditoTicket>('creditos_tickets')
      .find({ usuarioId: req.creditoUser!.userId })
      .sort({ actualizadoEn: -1 })
      .toArray();
    res.json(tickets);
  }

  async obtenerTicket(req: CreditoAuthRequest, res: Response): Promise<void> {
    const { id } = req.params;
    const ticket = await database
      .getCollection<CreditoTicket>('creditos_tickets')
      .findOne({ id, usuarioId: req.creditoUser!.userId });
    if (!ticket) {
      res.status(404).json({ error: 'Ticket no encontrado' });
      return;
    }
    res.json(ticket);
  }

  async crearTicket(req: CreditoAuthRequest, res: Response): Promise<void> {
    const { asunto, mensaje } = req.body;
    if (!asunto?.trim() || !mensaje?.trim()) {
      res.status(400).json({ error: 'Escribe un asunto y un mensaje' });
      return;
    }

    const usuario = await database.getCollection<CreditoUsuario>('creditos_usuarios').findOne({ id: req.creditoUser!.userId });
    const ahora = new Date();
    const ticket: CreditoTicket = {
      id: Date.now().toString(),
      usuarioId: req.creditoUser!.userId,
      tipo: 'consulta',
      asunto: asunto.trim(),
      estado: 'abierto',
      creadoPor: 'cliente',
      mensajes: [{ autor: 'cliente', autorNombre: usuario?.nombre, texto: mensaje.trim(), createdAt: ahora }],
      createdAt: ahora,
      actualizadoEn: ahora,
    };
    await database.getCollection<CreditoTicket>('creditos_tickets').insertOne(ticket);
    avisarTicketActualizado(req, ticket.id);
    res.status(201).json(ticket);
  }

  /** El cliente responde en un ticket propio; reabre uno cerrado si hacía falta seguir hablando. */
  async responderTicket(req: CreditoAuthRequest, res: Response): Promise<void> {
    const { id } = req.params;
    const { mensaje } = req.body;
    if (!mensaje?.trim()) {
      res.status(400).json({ error: 'Escribe un mensaje' });
      return;
    }

    const ticket = await database
      .getCollection<CreditoTicket>('creditos_tickets')
      .findOne({ id, usuarioId: req.creditoUser!.userId });
    if (!ticket) {
      res.status(404).json({ error: 'Ticket no encontrado' });
      return;
    }

    const usuario = await database.getCollection<CreditoUsuario>('creditos_usuarios').findOne({ id: req.creditoUser!.userId });
    const ahora = new Date();
    await database.getCollection<CreditoTicket>('creditos_tickets').updateOne(
      { id },
      {
        $push: { mensajes: { autor: 'cliente', autorNombre: usuario?.nombre, texto: mensaje.trim(), createdAt: ahora } },
        $set: { estado: 'abierto', actualizadoEn: ahora },
      },
    );
    avisarTicketActualizado(req, ticket.id);
    res.json({ message: 'Mensaje enviado' });
  }
}

export const creditosController = new CreditosController();
