import { Router, Request, Response } from 'express';
import { authenticateToken } from '../middlewares/auth.middleware';
import { recordatoriosController } from '../controllers/recordatorios.controller';

const router = Router();

router.post('/recordatorio-masivo', authenticateToken, async (req: Request, res: Response) => {
  await recordatoriosController.enviarRecordatorioMasivo(req, res);
});

export default router;
