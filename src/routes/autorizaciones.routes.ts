import { NextFunction, Request, Response, Router } from 'express';
import rateLimit from 'express-rate-limit';
import { Server } from 'socket.io';
import { autenticarCaja, autenticarMovil, exigirVinculo, nombreEscolares, RequestMovil } from '../middlewares/autorizaciones.middleware';
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
  vinculoPorEscolares,
  vistaVinculo,
} from '../services/autorizaciones-vinculos.service';

/**
 * Autorizaciones con clave de supervisor desde el celular: une las cajas de sellhub
 * (EscolaresPRO, app de escritorio en la red local de la tienda) con la app de
 * supervisores ion/escolares-pro. Este backend es el punto de encuentro porque ambos lo
 * alcanzan por internet; los permisos y la validación del PIN siguen en sellhub.
 *
 *   /api/autorizaciones/caja/...   sellhub (cabecera x-api-key)
 *   /api/autorizaciones/movil/...  la app (token de escolares + x-dispositivo-id)
 *   /api/autorizaciones/qr/...     celular nuevo que escanea el QR del principal (sin sesión)
 *   socket.io namespace /autorizaciones   tiempo real para la app
 */
const router = Router();

// ---------------------------------------------------------------- caja (sellhub)

const caja = Router();
caja.use(autenticarCaja);

caja.get('/codigos/:codigo', (req, res) => {
  res.json(consultarCodigo(req.params.codigo));
});

caja.get('/vinculos', async (_req, res) => {
  res.json(await listarVinculos());
});

caja.post('/vinculos', async (req, res) => {
  const { codigo, usuarioId, usuarioNombre } = req.body ?? {};
  if (typeof codigo !== 'string' || usuarioId === undefined || typeof usuarioNombre !== 'string') {
    res.status(400).json({ message: 'Faltan el código o el usuario' });
    return;
  }
  const { pushTokens: _tokens, ...vinculo } = await vincular(codigo, String(usuarioId), usuarioNombre.trim().slice(0, 150));
  res.status(201).json(vinculo);
});

caja.delete('/vinculos/:usuarioId', async (req, res) => {
  await desvincular(req.params.usuarioId);
  res.status(204).end();
});

caja.post('/solicitudes', async (req, res) => {
  res.status(201).json(await crearSolicitud(req.body ?? {}));
});

caja.get('/solicitudes/:id', (req, res) => {
  res.json(consultarDesdeCaja(req.params.id));
});

caja.post('/solicitudes/:id/resultado', (req, res) => {
  const { ok, supervisor, mensaje } = req.body ?? {};
  res.json(registrarResultado(req.params.id, ok === true, supervisor ?? null, mensaje ?? null));
});

caja.delete('/solicitudes/:id', (req, res) => {
  cancelarDesdeCaja(req.params.id);
  res.status(204).end();
});

/** Autorización hecha con el PIN en la propia caja (para el historial). */
caja.post('/historial', async (req, res) => {
  await registrarAutorizacionEnCaja(req.body ?? {});
  res.status(204).end();
});

/** Notificaciones de lo que pasa en el programa (inicios de sesión, "Solicitar supervisor"...). */
caja.post('/eventos', async (req, res) => {
  res.status(201).json(await crearEvento(req.body ?? {}));
});

/** Resumen del día para la pestaña "Resumen" de la app; va con la lista de admins de sellhub. */
caja.post('/panel', async (req, res) => {
  await guardarPanel(req.body ?? {});
  res.status(204).end();
});

/** Consultas de los admins (precio y existencia, mensajes): la PC que pregunta se las lleva. */
caja.get('/consultas', (req, res) => {
  res.json(tomarConsultas(req.query.tipos, req.query.equipo));
});

caja.post('/consultas/:id/respuesta', (req, res) => {
  responderConsulta(String(req.params.id), req.body ?? {});
  res.status(204).end();
});

// ---------------------------------------------------------------- celular

/** Además del vínculo, que sea un usuario de sellhub con rol admin. */
async function exigirAdmin(req: RequestMovil, res: Response, next: NextFunction): Promise<void> {
  if (!(await esAdministrador(req.vinculo!._id))) {
    res.status(403).json({ message: 'Solo los usuarios root pueden usar esta función', codigo: 'no_admin' });
    return;
  }
  next();
}

const movil = Router();
movil.use(autenticarMovil);

/** Estado del vínculo de esta cuenta en este celular. */
movil.get('/estado', async (req: RequestMovil, res) => {
  const vinculo = await vinculoPorEscolares(req.usuario!.userId);
  if (vinculo && vinculo.dispositivoId === req.dispositivoId) {
    res.json({ estado: 'vinculado', vinculo: vistaVinculo(vinculo), principal: true, esAdmin: await esAdministrador(vinculo._id) });
    return;
  }
  const secundario = vinculo ? await secundarioPorDispositivo(req.dispositivoId!) : null;
  if (vinculo && secundario?.sellhubUsuarioId === vinculo._id) {
    res.json({
      estado: 'vinculado',
      vinculo: { ...vistaVinculo(vinculo), dispositivoNombre: secundario.dispositivoNombre, vinculadoEn: secundario.vinculadoEn },
      principal: false,
      esAdmin: await esAdministrador(vinculo._id),
    });
    return;
  }
  if (vinculo) {
    res.json({ estado: 'otro_dispositivo', dispositivoNombre: vinculo.dispositivoNombre });
    return;
  }
  const vinculoDelCelular = await vinculoPorDispositivo(req.dispositivoId!);
  if (vinculoDelCelular) {
    res.json({ estado: 'celular_ocupado', escolaresNombre: vinculoDelCelular.escolaresNombre });
    return;
  }
  res.json({ estado: 'sin_vincular' });
});

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
  else await guardarPushToken(req.vinculo!, token, nativo);
  res.status(204).end();
});

/** Al cerrar sesión en el principal: deja de recibir push, pero el vínculo se mantiene. */
movil.delete('/push-token', exigirVinculo, async (req: RequestMovil, res) => {
  if (req.secundario) await borrarPushTokensSecundario(req.secundario);
  else await borrarPushTokens(req.vinculo!);
  res.status(204).end();
});

/** Pantalla Perfil: datos de la cuenta, del vínculo y los dispositivos vinculados. */
movil.get('/perfil', exigirVinculo, async (req: RequestMovil, res) => {
  const u = req.usuario!;
  const v = req.vinculo!;
  res.json({
    nombre: nombreEscolares(u),
    usuario: u.username ?? null,
    email: u.email ?? null,
    sellhubNombre: v.sellhubNombre,
    esAdmin: await esAdministrador(v._id),
    principal: !req.secundario,
    dispositivos: await listarDispositivos(v, req.dispositivoId!),
  });
});

movil.get('/dispositivos', exigirVinculo, async (req: RequestMovil, res) => {
  res.json(await listarDispositivos(req.vinculo!, req.dispositivoId!));
});

/** Cerrar sesión en un secundario: se desvincula (para volver hay que escanear otro QR). */
movil.delete('/dispositivos/este', exigirVinculo, async (req: RequestMovil, res) => {
  if (req.secundario) await retirarDispositivo(req.vinculo!, req.dispositivoId!, req.secundario.id);
  res.status(204).end();
});

/** Un secundario solo puede retirarse a sí mismo; el principal, a cualquiera. */
movil.delete('/dispositivos/:id', exigirVinculo, async (req: RequestMovil, res) => {
  await retirarDispositivo(req.vinculo!, req.dispositivoId!, String(req.params.id));
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

/** Solo usuarios de sellhub con rol admin (403 para los demás). */
movil.get('/panel', exigirVinculo, async (req: RequestMovil, res) => {
  res.json(await panelPara(req.vinculo!._id));
});

/** Precio y existencia de un producto o mensaje a una sesión abierta: lo contesta una PC de la tienda. */
movil.post('/consultas', exigirVinculo, exigirAdmin, (req: RequestMovil, res) => {
  const v = req.vinculo!;
  res.status(201).json(crearConsulta(v._id, v.sellhubNombre, req.body ?? {}));
});

/** Qué PCs de la tienda están atendiendo consultas ahora (indicador de la pestaña Consultar). */
movil.get('/tienda', exigirVinculo, exigirAdmin, (_req, res) => {
  res.json(estadoTienda());
});

movil.get('/consultas/:id', exigirVinculo, (req: RequestMovil, res) => {
  res.json(consultaPara(req.vinculo!._id, String(req.params.id)));
});

movil.get('/solicitudes', exigirVinculo, (req: RequestMovil, res) => {
  res.json(listarParaMovil(req.vinculo!._id));
});

/** Filtros: desde, hasta (ISO), estado y accion (separados por coma), origen, q; paginación con antes + limite. */
movil.get('/historial', exigirVinculo, async (req: RequestMovil, res) => {
  res.json(await listarHistorial(req.vinculo!._id, req.query as Record<string, unknown>));
});

movil.get('/historial/:id', exigirVinculo, async (req: RequestMovil, res) => {
  const registro = await obtenerHistorial(req.vinculo!._id, String(req.params.id));
  if (!registro) {
    res.status(404).json({ message: 'Registro no encontrado' });
    return;
  }
  res.json(registro);
});

/** Filtros: desde, hasta (ISO), tipo (separados por coma), q; paginación con antes + limite. */
movil.get('/eventos', exigirVinculo, async (req: RequestMovil, res) => {
  res.json(await listarEventos(req.vinculo!._id, req.query as Record<string, unknown>));
});

/** Limpia la lista de notificaciones: lo anterior solo se ve buscando con filtros. */
movil.post('/eventos/limpiar', exigirVinculo, async (req: RequestMovil, res) => {
  res.json(await limpiarEventos(req.vinculo!._id));
});

movil.get('/solicitudes/:id', exigirVinculo, (req: RequestMovil, res) => {
  res.json(solicitudParaMovil(String(req.params.id), req.vinculo!._id));
});

/** Widget de la pantalla de inicio: pendientes y, a los root, las ventas de hoy. */
movil.get('/widget', exigirVinculo, async (req: RequestMovil, res) => {
  const v = req.vinculo!;
  let ventas: { usd: number; facturas: number; actualizado: string | null } | null = null;
  if (await esAdministrador(v._id)) {
    const panel = (await panelPara(v._id).catch(() => null)) as { hoy?: { ventasUsd: number; facturas: number }; recibidoEn?: Date | string } | null;
    if (panel?.hoy) {
      ventas = {
        usd: panel.hoy.ventasUsd,
        facturas: panel.hoy.facturas,
        actualizado: panel.recibidoEn ? new Date(panel.recibidoEn).toISOString() : null,
      };
    }
  }
  res.json({ ...pendientesParaWidget(v._id), ventas });
});

movil.post('/solicitudes/:id/aprobar', exigirVinculo, (req: RequestMovil, res) => {
  const v = req.vinculo!;
  res.json(aprobarDesdeMovil(String(req.params.id), req.body?.pinCifrado, v._id, v.sellhubNombre));
});

movil.post('/solicitudes/:id/rechazar', exigirVinculo, (req: RequestMovil, res) => {
  const v = req.vinculo!;
  res.json(rechazarDesdeMovil(String(req.params.id), v._id, v.sellhubNombre));
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
  if (err instanceof ErrorAutorizaciones) {
    res.status(err.status).json({ message: err.message });
    return;
  }
  next(err);
});

/** Socket.io (namespace /autorizaciones) y la limpieza de solicitudes vencidas. */
export function registrarAutorizaciones(io: Server): void {
  registrarSocketAutorizaciones(io, async (escolaresUserId, dispositivoId) => {
    const vinculo = await vinculoPorEscolares(escolaresUserId);
    if (!vinculo) return null;
    if (vinculo.dispositivoId === dispositivoId) return vinculo._id;
    const secundario = await secundarioPorDispositivo(dispositivoId);
    return secundario?.sellhubUsuarioId === vinculo._id ? vinculo._id : null;
  });
  iniciarLimpieza();
  iniciarCierreDelDia();
}

export default router;
