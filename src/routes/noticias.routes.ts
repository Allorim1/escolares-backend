import { Router, Request, Response } from 'express';
import { noticiasController } from '../controllers/noticias.controller';
import { authenticateToken } from '../middlewares/auth.middleware';

const router = Router();

/**
 * @swagger
 * /api/noticias:
 *   get:
 *     summary: Obtener todas las noticias activas
 *     tags: [Noticias]
 *     responses:
 *       200:
 *         description: Lista de noticias activas
 */
router.get('/', (req: Request, res: Response) => noticiasController.getAll(req, res));

/**
 * @swagger
 * /api/noticias/admin:
 *   get:
 *     summary: Obtener todas las noticias (admin)
 *     tags: [Noticias]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Lista de todas las noticias
 */
router.get('/admin', authenticateToken, (req: Request, res: Response) => noticiasController.getAllAdmin(req, res));

/**
 * @swagger
 * /api/noticias/{id}:
 *   get:
 *     summary: Obtener noticia por ID
 *     tags: [Noticias]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Noticia encontrada
 */
router.get('/:id', (req: Request, res: Response) => noticiasController.getById(req, res));

/**
 * @swagger
 * /api/noticias:
 *   post:
 *     summary: Crear una nueva noticia
 *     tags: [Noticias]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - titulo
 *               - contenido
 *             properties:
 *               titulo:
 *                 type: string
 *               contenido:
 *                 type: string
 *               importante:
 *                 type: boolean
 *     responses:
 *       201:
 *         description: Noticia creada
 */
router.post('/', authenticateToken, (req: Request, res: Response) => noticiasController.create(req, res));

/**
 * @swagger
 * /api/noticias/{id}:
 *   put:
 *     summary: Actualizar una noticia
 *     tags: [Noticias]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               titulo:
 *                 type: string
 *               contenido:
 *                 type: string
 *               activa:
 *                 type: boolean
 *               importante:
 *                 type: boolean
 *     responses:
 *       200:
 *         description: Noticia actualizada
 */
router.put('/:id', authenticateToken, (req: Request, res: Response) => noticiasController.update(req, res));

/**
 * @swagger
* /api/noticias/{id}:
*   delete:
*     summary: Eliminar una noticia
*     tags: [Noticias]
*     security:
*       - bearerAuth: []
*     parameters:
*       - in: path
*         name: id
*         required: true
*         schema:
*           type: string
*     responses:
*       200:
*         description: Noticia eliminada
*/
router.delete('/:id', authenticateToken, (req: Request, res: Response) => noticiasController.delete(req, res));

export default router;