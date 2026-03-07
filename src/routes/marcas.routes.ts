import { Router, Request, Response } from 'express';
import { marcasController } from '../controllers/marcas.controller';

const router = Router();

/**
 * @swagger
 * /api/marcas:
 *   get:
 *     summary: Obtener todas las marcas
 *     tags: [Marcas]
 *     responses:
 *       200:
 *         description: Lista de marcas
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 $ref: '#/components/schemas/Marca'
 */
router.get('/', (req: Request, res: Response) => marcasController.getAll(req, res));

/**
 * @swagger
 * /api/marcas/{id}:
 *   get:
 *     summary: Obtener una marca por ID
 *     tags: [Marcas]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: ID de la marca
 *     responses:
 *       200:
 *         description: Marca encontrada
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Marca'
 *       404:
 *         description: Marca no encontrada
 */
router.get('/:id', (req: Request, res: Response) => marcasController.getById(req, res));

/**
 * @swagger
 * /api/marcas:
 *   post:
 *     summary: Crear una nueva marca
 *     tags: [Marcas]
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
 *         description: Marca creada
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Marca'
 */
router.post('/', (req: Request, res: Response) => marcasController.create(req, res));

/**
 * @swagger
 * /api/marcas/{id}:
 *   put:
 *     summary: Actualizar una marca
 *     tags: [Marcas]
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
 *               name:
 *                 type: string
 *               image:
 *                 type: string
 *     responses:
 *       200:
 *         description: Marca actualizada
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Marca'
 *       404:
 *         description: Marca no encontrada
 */
router.put('/:id', (req: Request, res: Response) => marcasController.update(req, res));

/**
 * @swagger
 * /api/marcas/{id}:
 *   delete:
 *     summary: Eliminar una marca
 *     tags: [Marcas]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       204:
 *         description: Marca eliminada
 *       404:
 *         description: Marca no encontrada
 */
router.delete('/:id', (req: Request, res: Response) => marcasController.delete(req, res));

export default router;
