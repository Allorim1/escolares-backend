import { Router, Request, Response } from 'express';
import { lineasController } from '../controllers/lineas.controller';
import { authenticateToken } from '../middlewares/auth.middleware';

const router = Router();

/**
 * @swagger
 * /api/lineas:
 *   get:
 *     summary: Obtener todas las líneas
 *     tags: [Líneas]
 *     responses:
 *       200:
 *         description: Lista de líneas
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 $ref: '#/components/schemas/Linea'
 */
router.get('/', (req: Request, res: Response) => lineasController.getAll(req, res));

/**
 * @swagger
 * /api/lineas/{id}:
 *   get:
 *     summary: Obtener una línea por ID
 *     tags: [Líneas]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Línea encontrada
 *       404:
 *         description: Línea no encontrada
 */
router.get('/:id', (req: Request, res: Response) => lineasController.getById(req, res));

/**
 * @swagger
 * /api/lineas:
 *   post:
 *     summary: Crear una nueva línea
 *     tags: [Líneas]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - name
 *             properties:
 *               name:
 *                 type: string
 *               image:
 *                 type: string
 *     responses:
 *       201:
 *         description: Línea creada
 */
router.post('/', authenticateToken, (req: Request, res: Response) =>
  lineasController.create(req, res),
);

/**
 * @swagger
 * /api/lineas/{id}:
 *   put:
 *     summary: Actualizar una línea
 *     tags: [Líneas]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Línea actualizada
 *       404:
 *         description: Línea no encontrada
 */
router.put('/:id', authenticateToken, (req: Request, res: Response) =>
  lineasController.update(req, res),
);

/**
 * @swagger
 * /api/lineas/{id}:
 *   delete:
 *     summary: Eliminar una línea
 *     tags: [Líneas]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       204:
 *         description: Línea eliminada
 */
router.delete('/:id', authenticateToken, (req: Request, res: Response) =>
  lineasController.delete(req, res),
);

/**
 * @swagger
 * /api/lineas/{id}/products:
 *   post:
 *     summary: Añadir producto a una línea
 *     tags: [Líneas]
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
 *               productId:
 *                 type: number
 *     responses:
 *       200:
 *         description: Producto añadido
 */
router.post('/:id/products', authenticateToken, (req: Request, res: Response) =>
  lineasController.addProduct(req, res),
);

/**
 * @swagger
 * /api/lineas/{id}/products:
 *   delete:
 *     summary: Eliminar producto de una línea
 *     tags: [Líneas]
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
 *               productId:
 *                 type: number
 *     responses:
 *       200:
 *         description: Producto eliminado
 */
router.delete('/:id/products', authenticateToken, (req: Request, res: Response) =>
  lineasController.removeProduct(req, res),
);

export default router;
