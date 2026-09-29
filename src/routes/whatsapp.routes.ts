import express, { NextFunction, Request, Response } from 'express';
import fs from 'fs';
import multer from 'multer';
import { Server } from 'socket.io';
import { authenticateToken } from '../middlewares/auth.middleware';
import { obtenerNumero, whatsappConfigurado, WhatsAppApiError } from '../services/whatsapp-api.service';
import {
  coleccionConversaciones,
  coleccionMensajes,
  enviarDesdePanel,
  limpiar,
  marcarConversacionLeida,
  Operador,
  puedeUsarWhatsApp,
  reintentarDescarga,
  reintentarEnvio,
  renombrarConversacion,
  rutaArchivo,
} from '../services/whatsapp-inbox.service';

/**
 * Empresas > WhatsApp: bandeja de conversaciones de la WhatsApp Cloud API.
 * Los mensajes entran por el webhook /api/redes-sociales/webhook/whatsapp y
 * llegan al panel en tiempo real por socket.io (sala 'whatsapp').
 */
const router = express.Router();

const MB = 1024 * 1024;
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * MB, files: 1 } });

const requireWhatsApp = (req: Request, res: Response, next: NextFunction): void => {
  puedeUsarWhatsApp(req.user)
    .then((ok) => (ok ? next() : res.status(403).json({ error: 'No tienes permiso para acceder a WhatsApp' })))
    .catch((error) => {
      console.error('Error verificando permiso de WhatsApp:', error);
      res.status(500).json({ error: 'Error al verificar permisos' });
    });
};

router.use(authenticateToken, requireWhatsApp);

/** "maria" encuentra "María": cada vocal (y la n) acepta sus variantes con tilde. */
function patronSinTildes(texto: string): string {
  const variantes: Record<string, string> = { a: 'aáàä', e: 'eéèë', i: 'iíìï', o: 'oóòö', u: 'uúùü', n: 'nñ' };
  return texto
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    .replace(/[aeioun]/gi, (c) => `[${variantes[c.toLowerCase()]}]`);
}

const io = (req: Request): Server | undefined => req.app.get('io');
const param = (req: Request, nombre: string): string => String(req.params[nombre] ?? '');

function operador(req: Request): Operador {
  const u = req.user!;
  return { userId: u.userId, nombre: u.nombre || u.username || u.email };
}

function responderError(res: Response, error: unknown, contexto: string): void {
  if (error instanceof WhatsAppApiError && error.status === 404) {
    res.status(404).json({ error: error.message });
    return;
  }
  console.error(`Error ${contexto}:`, error);
  res.status(500).json({ error: error instanceof Error ? error.message : `Error ${contexto}` });
}

router.get('/estado', async (_req, res) => {
  const configurado = whatsappConfigurado();
  res.json({ configurado, cuenta: configurado ? await obtenerNumero() : null });
});

router.get('/conversaciones', async (req, res) => {
  try {
    const buscar = String(req.query.buscar || '').trim();
    const filtro: Record<string, unknown> = {};
    if (buscar) {
      const re = { $regex: patronSinTildes(buscar), $options: 'i' };
      filtro.$or = [{ waId: re }, { nombre: re }, { alias: re }, { 'cliente.nombre': re }, { 'cliente.empresa': re }];
    }
    const lista = await coleccionConversaciones().find(filtro).sort({ updatedAt: -1 }).limit(300).toArray();
    res.json(lista.map(limpiar));
  } catch (error) {
    responderError(res, error, 'obteniendo conversaciones');
  }
});

/** Página de mensajes, del más viejo al más nuevo. `antes` = id del mensaje más viejo ya cargado. */
router.get('/conversaciones/:waId/mensajes', async (req, res) => {
  try {
    const waId = param(req, 'waId');
    const limite = Math.min(Math.max(parseInt(String(req.query.limite)) || 50, 1), 100);
    const filtro: Record<string, unknown> = { waId };

    const antesId = String(req.query.antes || '');
    if (antesId) {
      const ref = await coleccionMensajes().findOne({ id: antesId, waId });
      if (ref) filtro.$or = [{ fecha: { $lt: ref.fecha } }, { fecha: ref.fecha, _id: { $lt: ref._id } }];
    }

    const docs = await coleccionMensajes().find(filtro).sort({ fecha: -1, _id: -1 }).limit(limite + 1).toArray();
    const hayMas = docs.length > limite;
    res.json({ mensajes: docs.slice(0, limite).reverse().map(limpiar), hayMas });
  } catch (error) {
    responderError(res, error, 'obteniendo mensajes');
  }
});

router.post('/conversaciones/:waId/mensajes', async (req, res) => {
  try {
    const texto = String(req.body?.texto || '').trim();
    if (!texto) {
      res.status(400).json({ error: 'El mensaje está vacío' });
      return;
    }
    if (texto.length > 4096) {
      res.status(400).json({ error: 'El mensaje supera los 4096 caracteres que permite WhatsApp' });
      return;
    }
    const mensaje = await enviarDesdePanel(io(req), param(req, 'waId'), operador(req), {
      texto,
      citaId: req.body?.citaId || undefined,
    });
    res.status(201).json(limpiar(mensaje));
  } catch (error) {
    responderError(res, error, 'enviando mensaje');
  }
});

router.post('/conversaciones/:waId/media', (req, res) => {
  upload.single('archivo')(req, res, async (err: unknown) => {
    if (err) {
      const limite = err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE';
      res.status(400).json({ error: limite ? 'El archivo supera el máximo de 25 MB' : 'No se pudo recibir el archivo' });
      return;
    }
    if (!req.file) {
      res.status(400).json({ error: 'No se recibió ningún archivo' });
      return;
    }
    try {
      const caption = String(req.body?.texto || '').trim().slice(0, 1024);
      const mensaje = await enviarDesdePanel(io(req), param(req, 'waId'), operador(req), {
        texto: caption || undefined,
        citaId: req.body?.citaId || undefined,
        media: {
          buffer: req.file.buffer,
          mimetype: req.file.mimetype,
          // multer entrega el nombre en latin1; se recupera el UTF-8 original (tildes, ñ).
          nombre: Buffer.from(req.file.originalname, 'latin1').toString('utf8'),
        },
      });
      res.status(201).json(limpiar(mensaje));
    } catch (error) {
      responderError(res, error, 'enviando archivo');
    }
  });
});

router.post('/conversaciones/:waId/leer', async (req, res) => {
  try {
    const conv = await marcarConversacionLeida(io(req), param(req, 'waId'));
    if (!conv) {
      res.status(404).json({ error: 'Conversación no encontrada' });
      return;
    }
    res.json(limpiar(conv));
  } catch (error) {
    responderError(res, error, 'marcando como leída');
  }
});

router.patch('/conversaciones/:waId', async (req, res) => {
  try {
    const conv = await renombrarConversacion(io(req), param(req, 'waId'), String(req.body?.alias ?? ''));
    if (!conv) {
      res.status(404).json({ error: 'Conversación no encontrada' });
      return;
    }
    res.json(limpiar(conv));
  } catch (error) {
    responderError(res, error, 'renombrando conversación');
  }
});

router.post('/mensajes/:id/reintentar', async (req, res) => {
  try {
    const mensaje = await reintentarEnvio(io(req), param(req, 'id'), operador(req));
    if (!mensaje) {
      res.status(404).json({ error: 'El mensaje no existe o no se puede reintentar' });
      return;
    }
    res.status(201).json(limpiar(mensaje));
  } catch (error) {
    responderError(res, error, 'reintentando envío');
  }
});

router.post('/mensajes/:id/descargar', async (req, res) => {
  try {
    const ok = await reintentarDescarga(io(req), param(req, 'id'));
    res.json({ ok });
  } catch (error) {
    responderError(res, error, 'descargando adjunto');
  }
});

/** Sirve el adjunto de un mensaje (privado: requiere sesión y permiso de WhatsApp). */
router.get('/media/:id', async (req, res) => {
  try {
    const m = await coleccionMensajes().findOne({ id: param(req, 'id') });
    const ruta = m?.media?.archivo ? rutaArchivo(m.media.archivo) : null;
    if (!m?.media || !ruta || !fs.existsSync(ruta)) {
      res.status(404).json({ error: 'Archivo no encontrado' });
      return;
    }
    res.setHeader('Content-Type', m.media.mimetype);
    res.setHeader('Cache-Control', 'private, max-age=31536000, immutable');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    // Los adjuntos los manda cualquiera por WhatsApp: si uno fuera HTML/SVG no debe poder
    // ejecutar nada en este origen. Solo se muestran en línea imágenes, audio, video y PDF.
    res.setHeader('Content-Security-Policy', 'sandbox');
    const enLinea = /^(image\/(jpeg|png|webp|gif)|video\/|audio\/|application\/pdf$)/.test(m.media.mimetype);
    const nombre = m.media.nombre ? `; filename*=UTF-8''${encodeURIComponent(m.media.nombre)}` : '';
    res.setHeader('Content-Disposition', `${enLinea ? 'inline' : 'attachment'}${nombre}`);
    fs.createReadStream(ruta).pipe(res);
  } catch (error) {
    responderError(res, error, 'sirviendo archivo');
  }
});

export default router;
