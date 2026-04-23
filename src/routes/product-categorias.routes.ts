import { Router, Request, Response } from 'express';
import { authenticateToken } from '../middlewares/auth.middleware';
import { productCategoriasController } from '../controllers/product-categorias.controller';

const router = Router();

// Public endpoint - no auth required
router.get('/', async (req: Request, res: Response) => {
  await productCategoriasController.getAll(req, res);
});

router.post('/', authenticateToken, async (req: Request, res: Response) => {
  await productCategoriasController.create(req, res);
});

router.put('/:id', authenticateToken, async (req: Request, res: Response) => {
  await productCategoriasController.update(req, res);
});

router.delete('/:id', authenticateToken, async (req: Request, res: Response) => {
  await productCategoriasController.delete(req, res);
});

export default router;
