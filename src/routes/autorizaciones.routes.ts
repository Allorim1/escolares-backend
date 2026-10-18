import { NextFunction, Request, Response, Router } from 'express';
import { Server } from 'socket.io';
import { autenticarCaja, autenticarMovil, exigirVinculo, nombreEscolares, RequestMovil } from '../middlewares/autorizaciones.middleware';
import { registrarSocketAutorizaciones } from '../services/autorizaciones-socket.service';
import {
  aprobarDesdeMovil,
  cancelarDesdeCaja,
  consultarDesdeCaja,
  crearAviso,
  crearSolicitud,
  iniciarLimpieza,
  listarAvisosParaMovil,
  listarParaMovil,
  rechazarDesdeMovil,
  registrarResultado,
} from '../services/autorizaciones-solicitudes.service';
import {
  borrarPushTokens,
  consultarCodigo,
  desvincular,
  ErrorAutorizaciones,
  generarCodigo,
  guardarPushToken,
  listarVinculos,
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

caja.post('/avisos', async (req, res) => {
  res.status(201).json(await crearAviso(req.body ?? {}));
});

// ---------------------------------------------------------------- celular

const movil = Router();
movil.use(autenticarMovil);

/** Estado del vínculo de esta cuenta en este celular. */
movil.get('/estado', async (req: RequestMovil, res) => {
  const vinculo = await vinculoPorEscolares(req.usuario!.userId);
  if (vinculo && vinculo.dispositivoId === req.dispositivoId) {
    res.json({ estado: 'vinculado', vinculo: vistaVinculo(vinculo) });
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
  await guardarPushToken(req.vinculo!, token);
  res.status(204).end();
});

/** Al cerrar sesión en la app: deja de recibir push, pero el vínculo se mantiene. */
movil.delete('/push-token', exigirVinculo, async (req: RequestMovil, res) => {
  await borrarPushTokens(req.vinculo!);
  res.status(204).end();
});

movil.get('/solicitudes', exigirVinculo, (req: RequestMovil, res) => {
  res.json(listarParaMovil(req.vinculo!._id));
});

movil.get('/avisos', exigirVinculo, (req: RequestMovil, res) => {
  res.json(listarAvisosParaMovil(req.vinculo!._id));
});

movil.post('/solicitudes/:id/aprobar', exigirVinculo, (req: RequestMovil, res) => {
  const v = req.vinculo!;
  res.json(aprobarDesdeMovil(String(req.params.id), req.body?.pinCifrado, v._id, v.sellhubNombre));
});

movil.post('/solicitudes/:id/rechazar', exigirVinculo, (req: RequestMovil, res) => {
  const v = req.vinculo!;
  res.json(rechazarDesdeMovil(String(req.params.id), v._id, v.sellhubNombre));
});

router.use('/caja', caja);
router.use('/movil', movil);

router.use((err: unknown, _req: Request, res: Response, next: NextFunction) => {
  if (err instanceof ErrorAutorizaciones) {
    res.status(err.status).json({ message: err.message });
    return;
  }
  next(err);
});

/** Socket.io (namespace /autorizaciones) y la limpieza de solicitudes vencidas. */
export function registrarAutorizaciones(io: Server): void {
  registrarSocketAutorizaciones(io, vinculoPorEscolares);
  iniciarLimpieza();
}

export default router;
