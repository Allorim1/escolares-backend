import crypto from 'crypto';
import express, { NextFunction, Request, Response, Router } from 'express';
import rateLimit from 'express-rate-limit';
import { Server } from 'socket.io';
import {
  autenticarCaja,
  autenticarMovil,
  esperarMultitienda,
  exigirVinculo,
  nombreEscolares,
  RequestCaja,
  RequestMovil,
} from '../middlewares/autorizaciones.middleware';
import { registrarSocketAutorizaciones } from '../services/autorizaciones-socket.service';
import {
  aprobarDesdeMovil,
  cancelarDesdeCaja,
  consultarDesdeCaja,
  crearEvento,
  crearSolicitud,
  iniciarLimpieza,
  listarParaMovil,
  pendientesParaWidget,
  solicitudParaMovil,
  rechazarDesdeMovil,
  registrarAutorizacionEnCaja,
  registrarResultado,
} from '../services/autorizaciones-solicitudes.service';
import { limpiarEventos, listarEventos, listarHistorial, obtenerHistorial } from '../services/autorizaciones-historial.service';
import { esAdministrador, guardarPanel, iniciarCierreDelDia, panelPara } from '../services/autorizaciones-panel.service';
import { consultaPara, crearConsulta, estadoTienda, responderConsulta, tomarConsultas } from '../services/autorizaciones-consultas.service';
import {
  consultarEspera,
  crearQr,
  escanearQr,
  estadoQr,
  listarDispositivos,
  responderQr,
  retirarDispositivo,
} from '../services/autorizaciones-dispositivos.service';
import {
  borrarPushTokens,
  consultarCodigo,
  desvincular,
  ErrorAutorizaciones,
  generarCodigo,
  guardarPushToken,
  guardarPushTokenSecundario,
  borrarPushTokensSecundario,
  listarVinculos,
  secundarioPorDispositivo,
  vincular,
  vinculoPorDispositivo,
  VinculoAutorizaciones,
  coleccionSecundarios,
  vinculosDeTienda,
  vinculosPorEscolares,
  vistaVinculo,
  vistaVinculoCaja,
} from '../services/autorizaciones-vinculos.service';
import { ErrorTiendas, nombreTienda, prepararMultitienda } from '../services/autorizaciones-tiendas.service';
import {
  cerrarVista,
  crearVista,
  estadoVista,
  frameDeCelular,
  frameDePc,
  frameVista,
  iniciarLimpiezaPantallas,
  MAX_FRAME_BYTES,
  rechazarDesdeCelular,
  terminarDesdeCelular,
  vistasDePc,
} from '../services/autorizaciones-pantallas.service';
import { celularesConectados } from '../services/autorizaciones-socket.service';

/**
 * Autorizaciones con clave de supervisor desde el celular: une las cajas de sellhub
 * (EscolaresPRO, app de escritorio en la red local de cada tienda) con la app de
 * supervisores ion/escolares-pro. Este backend es el punto de encuentro porque ambos lo
 * alcanzan por internet; los permisos y la validación del PIN siguen en el sellhub de
 * cada tienda.
 *
 *   /api/autorizaciones/caja/...   sellhub (cabecera x-api-key = clave de SU tienda)
 *   /api/autorizaciones/movil/...  la app (token de escolares + x-dispositivo-id; con
 *                                  x-tienda-id o ?tienda= elige la tienda de la operación)
 *   /api/autorizaciones/qr/...     celular nuevo que escanea el QR del principal (sin sesión)
 *   socket.io namespace /autorizaciones   tiempo real para la app
 *
 * Multitienda: ver autorizaciones-tiendas.service.ts. Las tiendas se administran en
 * Gestión Multienda (/api/multitienda).
 */
const router = Router();
router.use(esperarMultitienda);

// ---------------------------------------------------------------- caja (sellhub)

const caja = Router();
caja.use(autenticarCaja);

const tiendaDe = (req: Request) => (req as RequestCaja).tienda!._id;

/** De qué tienda es esta clave (sellhub lo muestra y lo usa para probar una clave antes de guardarla). */
caja.get('/tienda', (req, res) => {
  const t = (req as RequestCaja).tienda!;
  res.json({ id: t._id, nombre: t.nombre, rif: t.rif, catalogoWeb: t.catalogoWeb });
});

caja.get('/codigos/:codigo', (req, res) => {
  res.json(consultarCodigo(String(req.params.codigo)));
});

caja.get('/vinculos', async (req, res) => {
  res.json(await listarVinculos(tiendaDe(req)));
});

caja.post('/vinculos', async (req, res) => {
  const { codigo, usuarioId, usuarioNombre } = req.body ?? {};
  if (typeof codigo !== 'string' || usuarioId === undefined || typeof usuarioNombre !== 'string') {
    res.status(400).json({ message: 'Faltan el código o el usuario' });
    return;
  }
  const vinculo = await vincular(codigo, tiendaDe(req), String(usuarioId), usuarioNombre.trim().slice(0, 150));
  res.status(201).json(vistaVinculoCaja(vinculo));
});

caja.delete('/vinculos/:usuarioId', async (req, res) => {
  await desvincular(tiendaDe(req), String(req.params.usuarioId));
  res.status(204).end();
});

caja.post('/solicitudes', async (req, res) => {
  res.status(201).json(await crearSolicitud(tiendaDe(req), req.body ?? {}));
});

caja.get('/solicitudes/:id', (req, res) => {
  res.json(consultarDesdeCaja(tiendaDe(req), String(req.params.id)));
});

caja.post('/solicitudes/:id/resultado', (req, res) => {
  const { ok, supervisor, mensaje } = req.body ?? {};
  res.json(registrarResultado(tiendaDe(req), String(req.params.id), ok === true, supervisor ?? null, mensaje ?? null));
});

caja.delete('/solicitudes/:id', (req, res) => {
  cancelarDesdeCaja(tiendaDe(req), String(req.params.id));
  res.status(204).end();
});

/** Autorización hecha con el PIN en la propia caja (para el historial). */
caja.post('/historial', async (req, res) => {
  await registrarAutorizacionEnCaja(tiendaDe(req), req.body ?? {});
  res.status(204).end();
});

/** Notificaciones de lo que pasa en el programa (inicios de sesión, "Solicitar supervisor"...). */
caja.post('/eventos', async (req, res) => {
  res.status(201).json(await crearEvento(tiendaDe(req), req.body ?? {}));
});

/** Resumen del día para la pestaña "Resumen" de la app; va con la lista de admins de ese sellhub. */
caja.post('/panel', async (req, res) => {
  await guardarPanel(tiendaDe(req), req.body ?? {});
  res.status(204).end();
});

/** Consultas de los admins (precio y existencia, mensajes): la PC que pregunta se las lleva. */
caja.get('/consultas', (req, res) => {
  res.json(tomarConsultas(tiendaDe(req), req.query.tipos, req.query.equipo));
});

caja.post('/consultas/:id/respuesta', (req, res) => {
  responderConsulta(tiendaDe(req), String(req.params.id), req.body ?? {});
  res.status(204).end();
});

/** Fotos de pantalla (JPEG crudo, hasta MAX_FRAME_BYTES). */
const cuerpoImagen = express.raw({ type: 'image/jpeg', limit: MAX_FRAME_BYTES });
const imagenDe = (req: Request): Buffer => (Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0));

/** "Ver pantalla" desde el celular: lo que piden ver de ESTA sesión de EscolaresPRO. */
caja.get('/pantallas', (req, res) => {
  res.json(vistasDePc(tiendaDe(req), String(req.query.sesion ?? '').slice(0, 64)));
});

/** Una foto de la pantalla de esta PC; { seguir: false } = ya nadie mira. */
caja.post('/pantallas/:id/frame', cuerpoImagen, (req, res) => {
  res.json(frameDePc(tiendaDe(req), String(req.params.id), imagenDe(req)));
});

// ---------------------------------------------------------------- celular

/** Las tiendas de la cuenta, con si es root en cada una. */
async function tiendasDe(vinculos: VinculoAutorizaciones[]) {
  return Promise.all(vinculos.map(async (v) => ({ ...vistaVinculo(v), esAdmin: await esAdministrador(v) })));
}

const pidioTienda = (req: Request) => !!(req.header('x-tienda-id') || req.query.tienda);

/**
 * Además del vínculo, que sea root en la tienda de la operación. Si la app no dijo tienda
 * (versión vieja), se usa la primera donde sea root.
 */
async function exigirAdmin(req: RequestMovil, res: Response, next: NextFunction): Promise<void> {
  let elegido: VinculoAutorizaciones | null = null;
  if (pidioTienda(req)) {
    elegido = (await esAdministrador(req.vinculo!)) ? req.vinculo! : null;
  } else {
    for (const v of req.vinculos!) {
      if (await esAdministrador(v)) {
        elegido = v;
        break;
      }
    }
  }
  if (!elegido) {
    res.status(403).json({ message: 'Solo los usuarios root pueden usar esta función', codigo: 'no_admin' });
    return;
  }
  req.vinculo = elegido;
  next();
}

const movil = Router();
movil.use(autenticarMovil);

/** Estado de esta cuenta en este celular, con sus tiendas. */
movil.get('/estado', async (req: RequestMovil, res) => {
  const vinculos = await vinculosPorEscolares(req.usuario!.userId);
  if (vinculos.length > 0) {
    const principal = vinculos[0].dispositivoId === req.dispositivoId;
    const secundario = principal ? null : await secundarioPorDispositivo(req.dispositivoId!);
    if (principal || secundario?.escolaresUserId === req.usuario!.userId) {
      const tiendas = await tiendasDe(vinculos);
      const primera = vistaVinculo(vinculos[0]);
      res.json({
        estado: 'vinculado',
        // `vinculo` y `esAdmin`: lo que entienden las versiones de la app de antes de multitienda.
        vinculo: secundario ? { ...primera, dispositivoNombre: secundario.dispositivoNombre, vinculadoEn: secundario.vinculadoEn } : primera,
        principal,
        esAdmin: tiendas.some((t) => t.esAdmin),
        tiendas,
      });
      return;
    }
    res.json({ estado: 'otro_dispositivo', dispositivoNombre: vinculos[0].dispositivoNombre });
    return;
  }
  const vinculoDelCelular = await vinculoPorDispositivo(req.dispositivoId!);
  if (vinculoDelCelular) {
    res.json({ estado: 'celular_ocupado', escolaresNombre: vinculoDelCelular.escolaresNombre });
    return;
  }
  res.json({ estado: 'sin_vincular' });
});

/** Código para vincular esta cuenta en una tienda (la primera o una más, desde el celular principal). */
movil.post('/codigo', async (req: RequestMovil, res) => {
  const nombre = typeof req.body?.dispositivoNombre === 'string' ? req.body.dispositivoNombre.trim().slice(0, 80) : '';
  res.status(201).json(
    await generarCodigo({
      escolaresUserId: req.usuario!.userId,
      escolaresNombre: nombreEscolares(req.usuario!),
      dispositivoId: req.dispositivoId!,
      dispositivoNombre: nombre || 'Celular',
    }),
  );
});

movil.post('/push-token', exigirVinculo, async (req: RequestMovil, res) => {
  const { token } = req.body ?? {};
  if (typeof token !== 'string' || !token) {
    res.status(400).json({ message: 'Falta el token' });
    return;
  }
  // nativo: la APK dibuja ella misma la notificación de solicitud (botones Aprobar/Rechazar).
  const nativo = req.body?.nativo === true;
  if (req.secundario) await guardarPushTokenSecundario(req.secundario, token, nativo);
  else await guardarPushToken(req.usuario!.userId, token, nativo);
  res.status(204).end();
});

/** Al cerrar sesión en el principal: deja de recibir push, pero los vínculos se mantienen. */
movil.delete('/push-token', exigirVinculo, async (req: RequestMovil, res) => {
  if (req.secundario) await borrarPushTokensSecundario(req.secundario);
  else await borrarPushTokens(req.usuario!.userId);
  res.status(204).end();
});

/** Pantalla Perfil: datos de la cuenta, sus tiendas y los dispositivos vinculados. */
movil.get('/perfil', exigirVinculo, async (req: RequestMovil, res) => {
  const u = req.usuario!;
  const v = req.vinculo!;
  const tiendas = await tiendasDe(req.vinculos!);
  res.json({
    nombre: nombreEscolares(u),
    usuario: u.username ?? null,
    email: u.email ?? null,
    sellhubNombre: v.sellhubNombre,
    esAdmin: tiendas.some((t) => t.esAdmin),
    principal: !req.secundario,
    tiendas,
    dispositivos: await listarDispositivos(v, req.dispositivoId!),
  });
});

movil.get('/dispositivos', exigirVinculo, async (req: RequestMovil, res) => {
  res.json(await listarDispositivos(req.vinculo!, req.dispositivoId!));
});

/** Cerrar sesión en un secundario: se desvincula (para volver hay que escanear otro QR). */
movil.delete('/dispositivos/este', exigirVinculo, async (req: RequestMovil, res) => {
  if (req.secundario) await retirarDispositivo(req.vinculo!, req.dispositivoId!, req.secundario.id, req.usuarios!);
  res.status(204).end();
});

/** Un secundario solo puede retirarse a sí mismo; el principal, a cualquiera. */
movil.delete('/dispositivos/:id', exigirVinculo, async (req: RequestMovil, res) => {
  await retirarDispositivo(req.vinculo!, req.dispositivoId!, String(req.params.id), req.usuarios!);
  res.status(204).end();
});

/** QR para vincular otro celular (solo el principal). */
movil.post('/dispositivos/qr', exigirVinculo, async (req: RequestMovil, res) => {
  res.status(201).json(await crearQr(req.vinculo!, req.dispositivoId!));
});

movil.get('/dispositivos/qr/:token', exigirVinculo, (req: RequestMovil, res) => {
  res.json(estadoQr(req.vinculo!, String(req.params.token)));
});

movil.post('/dispositivos/qr/:token/responder', exigirVinculo, async (req: RequestMovil, res) => {
  res.json(await responderQr(req.vinculo!, req.dispositivoId!, String(req.params.token), req.body?.aceptar === true, req));
});

/** Resumen de una tienda: solo root en esa tienda (403 para los demás). */
movil.get('/panel', exigirVinculo, exigirAdmin, async (req: RequestMovil, res) => {
  res.json(await panelPara(req.vinculo!));
});

/** Precio y existencia de un producto o mensaje a una sesión abierta: lo contesta una PC de esa tienda. */
movil.post('/consultas', exigirVinculo, exigirAdmin, (req: RequestMovil, res) => {
  const v = req.vinculo!;
  res.status(201).json({ ...crearConsulta(v.tiendaId, v._id, v.sellhubNombre, req.body ?? {}), tiendaId: v.tiendaId });
});

/** Qué PCs de la tienda están atendiendo consultas ahora (indicador de la pestaña Consultar). */
movil.get('/tienda', exigirVinculo, exigirAdmin, (req: RequestMovil, res) => {
  res.json({ ...estadoTienda(req.vinculo!.tiendaId), tiendaId: req.vinculo!.tiendaId });
});

// ---------------------------------------------------------------- ver pantallas (solo root)

/** Id público de un celular (no se reparte su dispositivoId). */
const claveCelular = (dispositivoId: string) => crypto.createHash('sha256').update(dispositivoId).digest('hex').slice(0, 24);

/** Celulares de esa tienda con la app abierta ahora: usuario, celular y en qué pantalla de la app están. */
async function celularesDeTienda(tiendaId: string, dispositivoActual: string) {
  const vinculos = await vinculosDeTienda(tiendaId);
  const porCuenta = new Map(vinculos.map((v) => [v.escolaresUserId, v]));
  const conectados = celularesConectados().filter((c) => porCuenta.has(c.escolaresUserId));
  const cuentas = [...new Set(conectados.map((c) => c.escolaresUserId))];
  const secundarios = cuentas.length ? await (await coleccionSecundarios()).find({ escolaresUserId: { $in: cuentas } }).toArray() : [];
  return conectados
    .map((c) => {
      const v = porCuenta.get(c.escolaresUserId)!;
      const secundario = secundarios.find((s) => s._id === c.dispositivoId && s.escolaresUserId === c.escolaresUserId);
      const principal = c.dispositivoId === v.dispositivoId;
      // Un celular con la sesión abierta pero que no es de la cuenta (ni principal ni secundario) no cuenta.
      if (!principal && !secundario) return null;
      return {
        clave: claveCelular(c.dispositivoId),
        dispositivoId: c.dispositivoId,
        escolaresUserId: c.escolaresUserId,
        usuario: v.sellhubNombre,
        celular: principal ? v.dispositivoNombre : secundario!.dispositivoNombre,
        principal,
        pantalla: c.pantalla,
        conectadoEn: new Date(c.conectadoEn).toISOString(),
        esEste: c.dispositivoId === dispositivoActual,
      };
    })
    .filter((c): c is NonNullable<typeof c> => c !== null)
    .sort((a, b) => a.usuario.localeCompare(b.usuario));
}

movil.get('/celulares', exigirVinculo, exigirAdmin, async (req: RequestMovil, res) => {
  const lista = await celularesDeTienda(req.vinculo!.tiendaId, req.dispositivoId!);
  res.json(lista.map(({ dispositivoId: _d, escolaresUserId: _e, ...publico }) => publico));
});

/** Pedir ver una pantalla. Body: { tipo: 'pc', objetivo: sesionId, nombre } o { tipo: 'celular', objetivo: clave }. */
movil.post('/pantallas', exigirVinculo, exigirAdmin, async (req: RequestMovil, res) => {
  const v = req.vinculo!;
  const tipo = req.body?.tipo === 'celular' ? 'celular' : req.body?.tipo === 'pc' ? 'pc' : null;
  const objetivo = typeof req.body?.objetivo === 'string' ? req.body.objetivo.trim().slice(0, 64) : '';
  if (!tipo || !objetivo) throw new ErrorAutorizaciones(400, 'Falta qué pantalla ver');
  const espectador = { _id: v._id, sellhubNombre: v.sellhubNombre, tiendaId: v.tiendaId };
  if (tipo === 'pc') {
    const nombre = typeof req.body?.nombre === 'string' && req.body.nombre.trim() ? req.body.nombre.trim() : 'PC';
    res.status(201).json(crearVista(espectador, { tipo, objetivo, objetivoNombre: nombre }, nombreTienda(v.tiendaId)));
    return;
  }
  const celular = (await celularesDeTienda(v.tiendaId, req.dispositivoId!)).find((c) => c.clave === objetivo);
  if (!celular) throw new ErrorAutorizaciones(404, 'Ese celular ya no tiene la app abierta');
  if (celular.esEste) throw new ErrorAutorizaciones(400, 'Ese es este mismo celular');
  res.status(201).json(
    crearVista(
      espectador,
      {
        tipo,
        objetivo: celular.dispositivoId,
        objetivoNombre: `${celular.usuario} · ${celular.celular}`,
        objetivoCuenta: celular.escolaresUserId,
      },
      nombreTienda(v.tiendaId),
    ),
  );
});

movil.get('/pantallas/:id', exigirVinculo, (req: RequestMovil, res) => {
  res.json(estadoVista(req.usuarios!, String(req.params.id)));
});

/** La última foto (JPEG); 204 si todavía no llegó ninguna. */
movil.get('/pantallas/:id/frame', exigirVinculo, (req: RequestMovil, res) => {
  const frame = frameVista(req.usuarios!, String(req.params.id));
  res.set('Cache-Control', 'no-store');
  if (!frame) {
    res.status(204).end();
    return;
  }
  res.type('image/jpeg').send(frame);
});

movil.delete('/pantallas/:id', exigirVinculo, (req: RequestMovil, res) => {
  cerrarVista(req.usuarios!, String(req.params.id));
  res.status(204).end();
});

/** El celular que se mira: sube una foto ({ seguir: false } = ya nadie mira). */
movil.post('/pantallas/:id/frame', exigirVinculo, cuerpoImagen, (req: RequestMovil, res) => {
  res.json(frameDeCelular(String(req.params.id), req.dispositivoId!, imagenDe(req)));
});

/** El celular que se mira no aceptó (en la app o en el aviso de Android). */
movil.post('/pantallas/:id/rechazar', exigirVinculo, (req: RequestMovil, res) => {
  rechazarDesdeCelular(String(req.params.id), req.dispositivoId!, req.body?.motivo);
  res.status(204).end();
});

/** El celular que se mira dejó de compartir (botón de su notificación). */
movil.post('/pantallas/:id/terminar', exigirVinculo, (req: RequestMovil, res) => {
  terminarDesdeCelular(String(req.params.id), req.dispositivoId!);
  res.status(204).end();
});

movil.get('/consultas/:id', exigirVinculo, (req: RequestMovil, res) => {
  res.json(consultaPara(req.usuarios!, String(req.params.id)));
});

/** Las solicitudes en curso de todas las tiendas de la cuenta. */
movil.get('/solicitudes', exigirVinculo, (req: RequestMovil, res) => {
  res.json(listarParaMovil(req.usuarios!));
});

/** Filtros: desde, hasta (ISO), estado y accion (separados por coma), origen, q, tienda; paginación con antes + limite. */
movil.get('/historial', exigirVinculo, async (req: RequestMovil, res) => {
  res.json(await listarHistorial(req.usuarios!, req.query as Record<string, unknown>));
});

movil.get('/historial/:id', exigirVinculo, async (req: RequestMovil, res) => {
  const registro = await obtenerHistorial(req.usuarios!, String(req.params.id));
  if (!registro) {
    res.status(404).json({ message: 'Registro no encontrado' });
    return;
  }
  res.json(registro);
});

/** Filtros: desde, hasta (ISO), tipo (separados por coma), q, tienda; paginación con antes + limite. */
movil.get('/eventos', exigirVinculo, async (req: RequestMovil, res) => {
  res.json(await listarEventos(req.usuarios!, req.usuario!.userId, req.query as Record<string, unknown>));
});

/** Limpia la lista de notificaciones (de todas las tiendas): lo anterior solo se ve buscando con filtros. */
movil.post('/eventos/limpiar', exigirVinculo, async (req: RequestMovil, res) => {
  res.json(await limpiarEventos(req.usuario!.userId));
});

movil.get('/solicitudes/:id', exigirVinculo, (req: RequestMovil, res) => {
  res.json(solicitudParaMovil(String(req.params.id), req.usuarios!));
});

/** Widget de la pantalla de inicio: pendientes y, a los root, las ventas de hoy (sumadas entre sus tiendas). */
movil.get('/widget', exigirVinculo, async (req: RequestMovil, res) => {
  let hay = false;
  let usd = 0;
  let facturas = 0;
  let actualizado: string | null = null;
  for (const v of req.vinculos!) {
    if (!(await esAdministrador(v))) continue;
    const panel = (await panelPara(v).catch(() => null)) as { hoy?: { ventasUsd: number; facturas: number }; recibidoEn?: string } | null;
    if (!panel?.hoy) continue;
    hay = true;
    usd += panel.hoy.ventasUsd;
    facturas += panel.hoy.facturas;
    const recibido = panel.recibidoEn ? new Date(panel.recibidoEn).toISOString() : null;
    // El dato más viejo: "actualizado" no debe aparentar más frescura de la que hay.
    if (recibido && (!actualizado || recibido < actualizado)) actualizado = recibido;
  }
  res.json({ ...pendientesParaWidget(req.usuarios!), ventas: hay ? { usd, facturas, actualizado } : null });
});

movil.post('/solicitudes/:id/aprobar', exigirVinculo, (req: RequestMovil, res) => {
  res.json(aprobarDesdeMovil(String(req.params.id), req.body?.pinCifrado, req.vinculos!));
});

movil.post('/solicitudes/:id/rechazar', exigirVinculo, (req: RequestMovil, res) => {
  res.json(rechazarDesdeMovil(String(req.params.id), req.vinculos!));
});

// ---------------------------------------------------------------- celular nuevo (QR)

/** Sin sesión: el límite frena a quien quiera adivinar códigos cortos. */
const qrLimiter = rateLimit({
  windowMs: 60_000,
  limit: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: 'Demasiados intentos. Espera un minuto.' },
});

const qr = Router();

/** Body: qr (texto del QR o código de 8 caracteres), dispositivoId, dispositivoNombre. */
qr.post('/escanear', qrLimiter, async (req, res) => {
  res.status(201).json(await escanearQr(req.body ?? {}));
});

/** El celular nuevo espera la respuesta del principal (sondeo cada pocos segundos). */
qr.get('/espera/:espera', (req, res) => {
  res.json(consultarEspera(String(req.params.espera), String(req.header('x-dispositivo-id') ?? '')));
});

router.use('/caja', caja);
router.use('/movil', movil);
router.use('/qr', qr);

router.use((err: unknown, _req: Request, res: Response, next: NextFunction) => {
  if (err instanceof ErrorAutorizaciones || err instanceof ErrorTiendas) {
    res.status(err.status).json({ message: err.message });
    return;
  }
  next(err);
});

/** Socket.io (namespace /autorizaciones), la migración a multitienda y las tareas periódicas. */
export function registrarAutorizaciones(io: Server): void {
  registrarSocketAutorizaciones(io, async (escolaresUserId, dispositivoId) => {
    await prepararMultitienda();
    const vinculos = await vinculosPorEscolares(escolaresUserId);
    if (vinculos.length === 0) return [];
    if (vinculos[0].dispositivoId === dispositivoId) return vinculos.map((v) => v._id);
    const secundario = await secundarioPorDispositivo(dispositivoId);
    return secundario?.escolaresUserId === escolaresUserId ? vinculos.map((v) => v._id) : [];
  });
  prepararMultitienda().catch((error) => console.error('Autorizaciones: no se pudo preparar multitienda:', error));
  iniciarLimpieza();
  iniciarLimpiezaPantallas();
  iniciarCierreDelDia();
}

export default router;
