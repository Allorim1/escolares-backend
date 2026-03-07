import { Router, Request, Response } from 'express';
import { ofertasController } from '../controllers/ofertas.controller';

const router = Router();

/**
 * @swagger
 * /api/ofertas:
 *   get:
 *     summary: Obtener todas las ofertas
 *     tags: [Ofertas]
 *     responses:
 *       200:
 *         description: Lista de ofertas
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 $ref: '#/components/schemas/Oferta'
 */
router.get('/', (req: Request, res: Response) => ofertasController.getAll(req, res));

/**
 * @swagger
 * /api/ofertas/product/{productId}:
 *   get:
 *     summary: Obtener oferta por ID de producto
 *     tags: [Ofertas]
 *     parameters:
 *       - in: path
 *         name: productId
 *         required: true
 *         schema:
 *           type: number
 *     responses:
 *       200:
 *         description: Oferta encontrada
 */
router.get('/product/:productId', (req: Request, res: Response) =>
  ofertasController.getByProductId(req, res),
);

/**
 * @swagger
 * /api/ofertas:
 *   post:
 *     summary: Crear o actualizar una oferta
 *     tags: [Ofertas]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - productId
 *               - precioOferta
 *             properties:
 *               productId:
 *                 type: number
 *               precioOferta:
 *                 type: number
 *     responses:
 *       201:
 *         description: Oferta creada
 */
router.post('/', (req: Request, res: Response) => ofertasController.create(req, res));

/**
 * @swagger
 * /api/ofertas/product/{productId}:
 *   delete:
 *     summary: Eliminar una oferta
 *     tags: [Ofertas]
 *     parameters:
 *       - in: path
 *         name: productId
 *         required: true
 *         schema:
 *           type: number
 *     responses:
 *       204:
 *         description: Oferta eliminada
 */
router.delete('/product/:productId', (req: Request, res: Response) =>
  ofertasController.delete(req, res),
);

export default router;
