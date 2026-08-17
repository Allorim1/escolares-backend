import { Router, Request, Response } from 'express';
import { supervisoresController } from '../controllers/supervisores.controller';
import { authenticateToken } from '../middlewares/auth.middleware';

const router = Router();

router.get('/', authenticateToken, (req: Request, res: Response) => supervisoresController.getAll(req, res));
router.post('/', authenticateToken, (req: Request, res: Response) => supervisoresController.create(req, res));
router.put('/:id', authenticateToken, (req: Request, res: Response) => supervisoresController.update(req, res));
router.delete('/:id', authenticateToken, (req: Request, res: Response) => supervisoresController.delete(req, res));

export default router;
