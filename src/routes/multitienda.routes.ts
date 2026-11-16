import { NextFunction, Request, Response, Router } from 'express';
import { authenticateToken, requireRoot } from '../middlewares/auth.middleware';
import { esperarMultitienda } from '../middlewares/autorizaciones.middleware';
import {
  actualizarTienda,
  crearTienda,
  ErrorTiendas,
  listarTiendas,
  regenerarClave,
  tiendaPorId,
  vistaTienda,
} from '../services/autorizaciones-tiendas.service';
import { desvincular, ErrorAutorizaciones } from '../services/autorizaciones-vinculos.service';
import { ultimoPanel } from '../services/autorizaciones-panel.service';
import { cantidadPcsActivas } from '../services/autorizaciones-consultas.service';
import { database } from '../config/database';

/**
 * Gestión Multienda (app de escritorio aparte de EscolaresPRO): alta de tiendas, nombres,
 * claves de cada servidor de sellhub, cuál alimenta el catálogo web y los celulares
 * vinculados en cada una. Solo cuentas de escolares con rol root.
 *
 *   GET    /api/multitienda/tiendas                      lista con estado (celulares, último resumen, PCs)
 *   POST   /api/multitienda/tiendas                      { nombre, rif?, catalogoWeb? } → { tienda, clave }
 *   PATCH  /api/multitienda/tiendas/:id                  { nombre?, rif?, activa?, catalogoWeb? }
 *   POST   /api/multitienda/tiendas/:id/clave            clave nueva → { tienda, clave } (la anterior deja de servir)
 *   GET    /api/multitienda/tiendas/:id/vinculos         celulares vinculados en esa tienda
 *   DELETE /api/multitienda/tiendas/:id/vinculos/:usuarioId   desvincular
 *
 * La clave se muestra UNA sola vez (al crear o regenerar): va en AUTORIZACION_MOVIL_API_KEY
 * del .env del servidor de sellhub de esa tienda.
 */
const router = Router();
router.use(authenticateToken, requireRoot, esperarMultitienda);

const vinculos = () =>
  database.getCollection<{
    _id: string;
    tiendaId: string;
    sellhubUsuarioId: string;
    sellhubNombre: string;
    escolaresNombre: string;
    dispositivoNombre: string;
    vinculadoEn: Date;
  }>('autorizaciones_vinculos');

router.get('/tiendas', async (_req, res) => {
  const tiendas = await listarTiendas();
  const conteo = await vinculos()
    .aggregate<{ _id: string; n: number }>([{ $group: { _id: '$tiendaId', n: { $sum: 1 } } }])
    .toArray();
  const celulares = new Map(conteo.map((c) => [c._id, c.n]));
  res.json(
    await Promise.all(
      tiendas.map(async (t) => ({
        ...vistaTienda(t),
        celulares: celulares.get(t._id) ?? 0,
        ultimoResumen: await ultimoPanel(t._id),
        pcsConectadas: cantidadPcsActivas(t._id),
      })),
    ),
  );
});

router.post('/tiendas', async (req, res) => {
  res.status(201).json(await crearTienda(req.body ?? {}));
});

router.patch('/tiendas/:id', async (req, res) => {
  res.json(await actualizarTienda(String(req.params.id), req.body ?? {}));
});

router.post('/tiendas/:id/clave', async (req, res) => {
  res.json(await regenerarClave(String(req.params.id)));
});

router.get('/tiendas/:id/vinculos', async (req, res) => {
  const id = String(req.params.id);
  if (!(await tiendaPorId(id))) throw new ErrorTiendas(404, 'La tienda no existe');
  const lista = await vinculos()
    .find({ tiendaId: id }, { projection: { sellhubUsuarioId: 1, sellhubNombre: 1, escolaresNombre: 1, dispositivoNombre: 1, vinculadoEn: 1 } })
    .sort({ sellhubNombre: 1 })
    .toArray();
  res.json(lista.map(({ _id: _interno, ...v }) => v));
});

router.delete('/tiendas/:id/vinculos/:usuarioId', async (req, res) => {
  const id = String(req.params.id);
  if (!(await tiendaPorId(id))) throw new ErrorTiendas(404, 'La tienda no existe');
  await desvincular(id, String(req.params.usuarioId));
  res.status(204).end();
});

router.use((err: unknown, _req: Request, res: Response, next: NextFunction) => {
  if (err instanceof ErrorTiendas || err instanceof ErrorAutorizaciones) {
    res.status(err.status).json({ message: err.message });
    return;
  }
  next(err);
});

export default router;
