import { Router, Request, Response } from 'express';
import { deliveryController } from '../controllers/delivery.controller';
import { authenticateToken } from '../middlewares/auth.middleware';

const router = Router();

/**
 * @swagger
 * /api/delivery:
 *   get:
 *     summary: Obtener todos los repartidores
 *     tags: [Repartidores]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Lista de repartidores
 */
router.get('/', authenticateToken, (req: Request, res: Response) => deliveryController.getAll(req, res));

/**
 * @swagger
 * /api/delivery/{id}:
 *   get:
 *     summary: Obtener un repartidor por ID
 *     tags: [Repartidores]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: ID del repartidor
 *     responses:
 *       200:
 *         description: Repartidor encontrado
 *       404:
 *         description: Repartidor no encontrado
 */
router.get('/:id', authenticateToken, (req: Request, res: Response) => deliveryController.getById(req, res));

/**
 * @swagger
 * /api/delivery:
 *   post:
 *     summary: Crear un nuevo repartidor
 *     tags: [Repartidores]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - nombre
 *             properties:
 *               nombre:
 *                 type: string
 *               telefono:
 *                 type: string
 *               activo:
 *                 type: boolean
 *     responses:
 *       201:
 *         description: Repartidor creado
 */
router.post('/', authenticateToken, (req: Request, res: Response) => deliveryController.create(req, res));

/**
 * @swagger
 * /api/delivery/{id}:
 *   put:
 *     summary: Actualizar un repartidor
 *     tags: [Repartidores]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: ID del repartidor
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               nombre:
 *                 type: string
 *               telefono:
 *                 type: string
 *               activo:
 *                 type: boolean
 *     responses:
 *       200:
 *         description: Repartidor actualizado
 *       404:
 *         description: Repartidor no encontrado
 */
router.put('/:id', authenticateToken, (req: Request, res: Response) => deliveryController.update(req, res));

/**
 * @swagger
 * /api/delivery/{id}:
 *   delete:
 *     summary: Eliminar un repartidor
 *     tags: [Repartidores]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: ID del repartidor
 *     responses:
 *       200:
 *         description: Repartidor eliminado
 *       404:
 *         description: Repartidor no encontrado
 *       400:
 *         description: No se puede eliminar porque tiene pedidos asignados
 */
router.delete('/:id', authenticateToken, (req: Request, res: Response) => deliveryController.delete(req, res));

export default router;