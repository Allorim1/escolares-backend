import { Router, Request, Response } from 'express';
import { deliveryController } from '../controllers/delivery.controller';
import { googleMapsService } from '../services/google-maps.service';
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

/**
 * @swagger
 * /api/delivery/{id}/location:
 *   put:
 *     summary: Actualizar ubicación del repartidor
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
 *             required:
 *               - lat
 *               - lng
 *             properties:
 *               lat:
 *                 type: number
 *               lng:
 *                 type: number
 *     responses:
 *       200:
 *         description: Ubicación actualizada
 */
router.put('/:id/location', authenticateToken, (req: Request, res: Response) => deliveryController.updateLocation(req, res));

/**
 * @swagger
 * /api/delivery/order/{orderId}/tracking:
 *   get:
 *     summary: Obtener seguimiento de un pedido
 *     tags: [Repartidores]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: orderId
 *         required: true
 *         schema:
 *           type: string
 *         description: ID del pedido
 *     responses:
 *       200:
 *         description: Información de seguimiento
 */
router.get('/order/:orderId/tracking', authenticateToken, (req: Request, res: Response) => deliveryController.getOrderTracking(req, res));

/**
 * @swagger
 * /api/maps/autocomplete:
 *   get:
 *     summary: Autocomplete de direcciones (Places API)
 *     tags: [Maps]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: input
 *         required: true
 *         schema:
 *           type: string
 *         description: Texto de búsqueda
 *     responses:
 *       200:
 *         description: Sugerencias de direcciones
 */
router.get('/maps/autocomplete', authenticateToken, async (req: Request, res: Response) => {
  try {
    const { input } = req.query;
    if (!input) {
      res.status(400).json({ error: 'El parámetro input es requerido' });
      return;
    }
    const predictions = await googleMapsService.autocomplete(input as string);
    res.json(predictions);
  } catch (error) {
    console.error('Error in autocomplete:', error);
    res.status(500).json({ error: 'Error en autocomplete' });
  }
});

/**
 * @swagger
 * /api/maps/geocode:
 *   get:
 *     summary: Geocodificar dirección (Geocoding API)
 *     tags: [Maps]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: address
 *         required: true
 *         schema:
 *           type: string
 *         description: Dirección a geocodificar
 *     responses:
 *       200:
 *         description: Información de geocodificación
 */
router.get('/maps/geocode', authenticateToken, async (req: Request, res: Response) => {
  try {
    const { address } = req.query;
    if (!address) {
      res.status(400).json({ error: 'El parámetro address es requerido' });
      return;
    }
    const result = await googleMapsService.geocode(address as string);
    res.json(result);
  } catch (error) {
    console.error('Error in geocode:', error);
    res.status(500).json({ error: 'Error en geocodificación' });
  }
});

/**
 * @swagger
 * /api/maps/geocode/place/{placeId}:
 *   get:
 *     summary: Geocodificar por Place ID (Geocoding API)
 *     tags: [Maps]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: placeId
 *         required: true
 *         schema:
 *           type: string
 *         description: Place ID de Google
 *     responses:
 *       200:
 *         description: Información de geocodificación
 */
router.get('/maps/geocode/place/:placeId', authenticateToken, async (req: Request, res: Response) => {
  try {
    const placeId = req.params.placeId as string;
    const result = await googleMapsService.geocodePlaceId(placeId);
    res.json(result);
  } catch (error) {
    console.error('Error in geocode by placeId:', error);
    res.status(500).json({ error: 'Error en geocodificación' });
  }
});

export default router;