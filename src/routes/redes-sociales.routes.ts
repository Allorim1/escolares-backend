import express from 'express';
import { redesSocialesController } from '../controllers/redes-sociales.controller';
import { authenticateToken } from '../middlewares/auth.middleware';

const router = express.Router();

// Redes Sociales
router.get('/redes', authenticateToken, (req, res) => redesSocialesController.getRedesSociales(req, res));
router.post('/redes', authenticateToken, (req, res) => redesSocialesController.createRedSocial(req, res));
router.put('/redes/:id', authenticateToken, (req, res) => redesSocialesController.updateRedSocial(req, res));
router.delete('/redes/:id', authenticateToken, (req, res) => redesSocialesController.deleteRedSocial(req, res));

// Mensajes
router.get('/mensajes', authenticateToken, (req, res) => redesSocialesController.getMensajes(req, res));
router.post('/mensajes', authenticateToken, (req, res) => redesSocialesController.createMensaje(req, res));
router.put('/mensajes/:id', authenticateToken, (req, res) => redesSocialesController.updateMensaje(req, res));
router.delete('/mensajes/:id', authenticateToken, (req, res) => redesSocialesController.deleteMensaje(req, res));

// Respuestas Automáticas
router.get('/respuestas-automaticas', authenticateToken, (req, res) => redesSocialesController.getRespuestasAutomaticas(req, res));
router.post('/respuestas-automaticas', authenticateToken, (req, res) => redesSocialesController.createRespuestaAutomatica(req, res));
router.put('/respuestas-automaticas/:id', authenticateToken, (req, res) => redesSocialesController.updateRespuestaAutomatica(req, res));
router.delete('/respuestas-automaticas/:id', authenticateToken, (req, res) => redesSocialesController.deleteRespuestaAutomatica(req, res));

// Notificaciones
router.get('/notificaciones', authenticateToken, (req, res) => redesSocialesController.getNotificaciones(req, res));
router.post('/notificaciones', authenticateToken, (req, res) => redesSocialesController.createNotificacion(req, res));
router.put('/notificaciones/:id', authenticateToken, (req, res) => redesSocialesController.updateNotificacion(req, res));
router.delete('/notificaciones/:id', authenticateToken, (req, res) => redesSocialesController.deleteNotificacion(req, res));

// Webhook WhatsApp
router.get('/webhook/whatsapp', (req, res) => redesSocialesController.verifyWebhook(req, res));
router.post('/webhook/whatsapp', (req, res) => redesSocialesController.webhookWhatsApp(req, res));

export default router;