import { Router, Request, Response } from 'express';
import { authenticateToken } from '../middlewares/auth.middleware';
import { recordatoriosController } from '../controllers/recordatorios.controller';

const router = Router();

router.post('/recordatorio-masivo', authenticateToken, async (req: Request, res: Response) => {
  await recordatoriosController.enviarRecordatorioMasivo(req, res);
});

router.post('/test-whatsapp', authenticateToken, async (req: Request, res: Response) => {
  await recordatoriosController.enviarTestWhatsApp(req, res);
});

export default router;
