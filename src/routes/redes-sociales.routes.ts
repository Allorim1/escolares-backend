import express from 'express';
import multer from 'multer';
import path from 'path';
import { redesSocialesController } from '../controllers/redes-sociales.controller';
import { authenticateToken } from '../middlewares/auth.middleware';

// Configurar multer para subida de archivos
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, path.join(__dirname, '../../uploads'));
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, uniqueSuffix + path.extname(file.originalname));
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 25 * 1024 * 1024 }, // 25MB límite
  fileFilter: (req, file, cb) => {
    // Permitir imágenes, videos y documentos comunes
    const allowedTypes = [
      'image/jpeg', 'image/png', 'image/gif', 'image/webp',
      'video/mp4', 'video/avi', 'video/mov',
      'application/pdf', 'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    ];
    if (allowedTypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Tipo de archivo no permitido'));
    }
  }
});

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

// Webhook Instagram
router.get('/webhook/instagram', (req, res) => redesSocialesController.verifyInstagramWebhook(req, res));
router.post('/webhook/instagram', (req, res) => redesSocialesController.webhookInstagram(req, res));

// Subida de archivos multimedia
router.post('/upload-media', authenticateToken, upload.single('file'), (req, res) => {
  try {
    if (!req.file) {
      res.status(400).json({ error: 'No file uploaded' });
      return;
    }

    const fileUrl = `${req.protocol}://${req.get('host')}/uploads/${req.file.filename}`;
    res.json({
      url: fileUrl,
      filename: req.file.originalname,
      mimetype: req.file.mimetype,
      size: req.file.size
    });
  } catch (error) {
    console.error('Error uploading file:', error);
    res.status(500).json({ error: 'Error uploading file' });
  }
});

export default router;