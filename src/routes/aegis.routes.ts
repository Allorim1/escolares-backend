import { NextFunction, Request, Response, Router } from 'express';
import rateLimit from 'express-rate-limit';
import { authenticateToken, requireRoot } from '../middlewares/auth.middleware';
import {
  ErrorAegis,
  listarErrores,
  listarInstalacionesRevocadas,
  listarLicencias,
  marcarErrorResuelto,
  recibirErrores,
  registrarLicencia,
  revocarInstalacion,
  revocarLicencia,
  verificarLicencia,
} from '../services/aegis.service';

/**
 * Aegis (versión comercial de sellhub): ver services/aegis.service.ts.
 *
 * Públicas (las llama cada instalación de Aegis, sin sesión, con límite por IP):
 *   POST /api/aegis/licencia/verificar     { licencia, instalacion, nonce, version, equipo } → { datos, firma }
 *   POST /api/aegis/errores                { instalacion, cliente, version, equipo, reportes[] }
 *
 * Solo root (Aegis Gestión):
 *   GET   /api/aegis/licencias                         licencias registradas + instalaciones revocadas
 *   POST  /api/aegis/licencias                         { texto } registra una licencia recién emitida
 *   POST  /api/aegis/licencias/:id/revocar             { motivo }
 *   POST  /api/aegis/licencias/:id/restaurar
 *   POST  /api/aegis/instalaciones/:codigo/revocar     { motivo }  todas sus licencias, también las futuras
 *   POST  /api/aegis/instalaciones/:codigo/restaurar
 *   GET   /api/aegis/errores?instalacion=&resueltos=1&limite=
 *   PATCH /api/aegis/errores/:id                       { resuelto }
 */
const router = Router();

const limitePublico = (limite: number) =>
  rateLimit({
    windowMs: 15 * 60_000,
    limit: limite,
    standardHeaders: true,
    legacyHeaders: false,
    message: { message: 'Demasiadas solicitudes. Intenta más tarde.' },
  });

router.post('/licencia/verificar', limitePublico(120), async (req, res) => {
  res.json(await verificarLicencia(req.body ?? {}));
});

router.post('/errores', limitePublico(60), async (req, res) => {
  res.status(202).json(await recibirErrores(req.body ?? {}));
});

const admin = Router();
admin.use(authenticateToken, requireRoot);

admin.get('/licencias', async (_req, res) => {
  const [lista, instalaciones] = await Promise.all([listarLicencias(), listarInstalacionesRevocadas()]);
  res.json({ licencias: lista, instalacionesRevocadas: instalaciones });
});

admin.post('/licencias', async (req, res) => {
  res.status(201).json(await registrarLicencia(req.body?.texto));
});

admin.post('/licencias/:id/revocar', async (req, res) => {
  res.json(await revocarLicencia(String(req.params.id), true, req.body?.motivo));
});

admin.post('/licencias/:id/restaurar', async (req, res) => {
  res.json(await revocarLicencia(String(req.params.id), false, ''));
});

admin.post('/instalaciones/:codigo/revocar', async (req, res) => {
  res.json(await revocarInstalacion(String(req.params.codigo), true, req.body?.motivo));
});

admin.post('/instalaciones/:codigo/restaurar', async (req, res) => {
  res.json(await revocarInstalacion(String(req.params.codigo), false, ''));
});

admin.get('/errores', async (req, res) => {
  res.json(
    await listarErrores({
      instalacion: typeof req.query.instalacion === 'string' ? req.query.instalacion : undefined,
      incluirResueltos: req.query.resueltos === '1',
      limite: Number(req.query.limite) || undefined,
    })
  );
});

admin.patch('/errores/:id', async (req, res) => {
  await marcarErrorResuelto(String(req.params.id), req.body?.resuelto !== false);
  res.status(204).end();
});

router.use(admin);

router.use((err: unknown, _req: Request, res: Response, next: NextFunction) => {
  if (err instanceof ErrorAegis) {
    res.status(err.status).json({ message: err.message });
    return;
  }
  next(err);
});

export default router;
