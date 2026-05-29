import { Router, Request, Response } from 'express';
import { authenticateToken } from '../middlewares/auth.middleware';
import { categoriasController } from '../controllers/categorias.controller';

const router = Router();

router.get('/', async (req: Request, res: Response) => {
  await categoriasController.getAll(req, res);
});

router.post('/', authenticateToken, async (req: Request, res: Response) => {
  await categoriasController.create(req, res);
});

router.put('/:id', authenticateToken, async (req: Request, res: Response) => {
  await categoriasController.update(req, res);
});

router.delete('/:id', authenticateToken, async (req: Request, res: Response) => {
  await categoriasController.delete(req, res);
});

router.post('/:id/items', authenticateToken, async (req: Request, res: Response) => {
  await categoriasController.addItem(req, res);
});

router.delete('/:id/items/:itemIndex', authenticateToken, async (req: Request, res: Response) => {
  await categoriasController.removeItem(req, res);
});

export default router;