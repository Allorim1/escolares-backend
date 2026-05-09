import express from 'express';
import multer from 'multer';
import path from 'path';
import { redesSocialesController } from '../controllers/redes-sociales.controller';
import { authenticateToken } from '../middlewares/auth.middleware';
import { database } from '../config/database';
import { MensajeRedSocial } from '../models';

// Configurar multer para subida de archivos
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const uploadPath = path.join(__dirname, '../../uploads');
    console.log('Upload destination:', uploadPath);
    cb(null, uploadPath);
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

// Webhook Instagram - Sin middleware de autenticación
router.get('/webhook/instagram', (req, res) => {
  console.log('GET /webhook/instagram - Verificación de webhook');
  return redesSocialesController.verifyInstagramWebhook(req, res);
});
router.post('/webhook/instagram', (req, res) => {
  console.log('POST /webhook/instagram - Mensaje recibido');
  return redesSocialesController.webhookInstagram(req, res);
});

// Endpoint de prueba para verificar webhooks
router.get('/test-webhook', (req, res) => {
  res.json({
    status: 'Webhook endpoint funcionando',
    timestamp: new Date().toISOString(),
    instagram_webhook_url: '/api/redes-sociales/webhook/instagram',
    environment: {
      INSTAGRAM_WEBHOOK_VERIFY_TOKEN: process.env.INSTAGRAM_WEBHOOK_VERIFY_TOKEN ? 'CONFIGURADO' : 'NO CONFIGURADO',
      NODE_ENV: process.env.NODE_ENV
    }
  });
});

// Endpoint para verificar configuración completa
router.get('/check-config', (req, res) => {
  return redesSocialesController.checkWebhookConfig(req, res);
});

// Endpoint para simular un webhook de Instagram (solo para testing)
router.post('/test-webhook/instagram', (req, res) => {
  console.log('🧪 TEST WEBHOOK - Simulando recepción de mensaje Instagram');
  console.log('Headers:', JSON.stringify(req.headers, null, 2));
  console.log('Body:', JSON.stringify(req.body, null, 2));

  // Procesar como si fuera un webhook real
  redesSocialesController.webhookInstagram(req, res);
});

// Endpoint para enviar un mensaje de prueba a Instagram
router.post('/test-send-message', authenticateToken, async (req, res) => {
  try {
    const { plataforma, usuario, texto } = req.body;

    if (!plataforma || !usuario || !texto) {
      return res.status(400).json({ error: 'Se requieren plataforma, usuario y texto' });
    }
    
    // Crear mensaje de prueba
    const mensajePrueba = {
      id: `test-${Date.now()}`,
      plataforma,
      usuario,
      texto: `[TEST] ${texto}`,
      fecha: new Date(),
      leido: false,
      respondido: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    await database.getCollection('redes-sociales-mensajes').insertOne(mensajePrueba);

    // Emitir evento de nuevo mensaje
    // Nota: No podemos acceder a global.io aquí fácilmente, así que omitimos esta parte por ahora
    // El evento se emitirá cuando el mensaje se procese normalmente a través del controlador

    res.json({ success: true, message: 'Mensaje de prueba enviado', mensaje: mensajePrueba });
  } catch (error) {
    console.error('Error enviando mensaje de prueba:', error);
    res.status(500).json({ error: 'Error al enviar mensaje de prueba' });
  }
});

// Endpoint para obtener estadísticas de mensajes
router.get('/mensajes/stats', authenticateToken, async (req, res) => {
  try {
    const totalMensajes = await database.getCollection('redes-sociales-mensajes').countDocuments();
    const mensajesPorPlataforma = await database.getCollection('redes-sociales-mensajes').aggregate([
      { $group: { _id: '$plataforma', count: { $sum: 1 } } }
    ]).toArray();

    const mensajesRecientes = await database.getCollection('redes-sociales-mensajes')
      .find({})
      .sort({ fecha: -1 })
      .limit(5)
      .allowDiskUse(true)
      .toArray();

    res.json({
      success: true,
      stats: {
        total: totalMensajes,
        porPlataforma: mensajesPorPlataforma,
        recientes: mensajesRecientes
      }
    });
  } catch (error) {
    console.error('Error obteniendo estadísticas:', error);
    res.status(500).json({ error: 'Error al obtener estadísticas' });
  }
});

// Endpoint para obtener mensajes recientes (para testing)
router.get('/mensajes/recientes', authenticateToken, async (req, res) => {
  try {
    const limit = parseInt(req.query.limit as string) || 10;
    const mensajes = await database
      .getCollection('redes-sociales-mensajes')
      .find({})
      .sort({ fecha: -1 })
      .limit(limit)
      .allowDiskUse(true)
      .toArray();

    res.json({
      success: true,
      count: mensajes.length,
      mensajes: mensajes
    });
  } catch (error) {
    console.error('Error obteniendo mensajes recientes:', error);
    res.status(500).json({ error: 'Error al obtener mensajes recientes' });
  }
});

// Subida de archivos multimedia
router.post('/upload-media', authenticateToken, (req, res) => {
  const uploadSingle = upload.single('file');

  uploadSingle(req, res, (err) => {
    if (err) {
      console.error('Multer error:', err);
      if (err instanceof multer.MulterError) {
        if (err.code === 'LIMIT_FILE_SIZE') {
          return res.status(400).json({ error: 'File too large. Maximum size is 25MB.' });
        }
      }
      return res.status(400).json({ error: err.message || 'File upload error' });
    }

    try {
      if (!req.file) {
        res.status(400).json({ error: 'No file uploaded' });
        return;
      }

      const fileUrl = `${req.protocol}://${req.get('host')}/uploads/${req.file.filename}`;
      console.log('File uploaded successfully:', {
        url: fileUrl,
        filename: req.file.originalname,
        mimetype: req.file.mimetype,
        size: req.file.size
      });

      res.json({
        url: fileUrl,
        filename: req.file.originalname,
        mimetype: req.file.mimetype,
        size: req.file.size
      });
    } catch (error) {
      console.error('Error processing uploaded file:', error);
      res.status(500).json({ error: 'Error processing uploaded file' });
    }
  });
});

export default router;