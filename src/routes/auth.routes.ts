import { Router, Request, Response } from 'express';
import rateLimit from 'express-rate-limit';
import { authController } from '../controllers/auth.controller';
import { authenticateToken } from '../middlewares/auth.middleware';
import { database } from '../config/database';

const router = Router();

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  skipSuccessfulRequests: true,
  message: { error: 'Demasiados intentos, intente en 15 minutos' },
  standardHeaders: true,
  legacyHeaders: false,
});

const crearRegistro = async (accion: string, modulo: string, descripcion: string, datos: any, usuario: string) => {
  const db = database.db;
  if (!db) return;
  let registrosCollection = db.collection('registros');
  const exists = await db.listCollections().toArray();
  const names = exists.map((c: any) => c.name);
  if (!names.includes('registros')) {
    await db.createCollection('registros');
    registrosCollection = db.collection('registros');
  }
  await registrosCollection.insertOne({
    accion,
    modulo,
    descripcion,
    datos,
    usuario,
    fecha: new Date(),
  });
};

/**
 * @swagger
 * /api/auth/register:
 *   post:
 *     summary: Registrar un nuevo usuario
 *     tags: [Auth]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - username
 *               - email
 *               - password
 *             properties:
 *               username:
 *                 type: string
 *               email:
 *                 type: string
 *               password:
 *                 type: string
 *     responses:
 *       201:
 *         description: Usuario registrado
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/User'
 */
router.post('/register', authLimiter, (req: Request, res: Response) => authController.register(req, res));

router.post('/register-simple', authenticateToken, (req: Request, res: Response) => authController.registerSimple(req, res));

/**
 * @swagger
 * /api/auth/login:
 *   post:
 *     summary: Iniciar sesión
 *     tags: [Auth]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - email
 *               - password
 *             properties:
 *               email:
 *                 type: string
 *               password:
 *                 type: string
 *     responses:
 *       200:
 *         description: Login exitoso
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/User'
 *       401:
 *         description: Credenciales inválidas
 */
router.post('/login', authLimiter, (req: Request, res: Response) => authController.login(req, res));

/**
 * @swagger
 * /api/auth/logout:
 *   post:
 *     summary: Cerrar sesión
 *     tags: [Auth]
 *     responses:
 *       200:
 *         description: Sesión cerrada
 */
router.post('/logout', (req: Request, res: Response) => authController.logout(req, res));

/**
 * @swagger
 * /api/auth/refresh:
 *   post:
 *     summary: Renovación de token de acceso
 *     tags: [Auth]
 *     responses:
 *       200:
 *         description: Nuevo token de acceso
 */
router.post('/refresh', (req: Request, res: Response) => authController.refreshToken(req, res));

/**
 * @swagger
 * /api/auth/users:
 *   get:
 *     summary: Obtener todos los usuarios
 *     tags: [Auth]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Lista de usuarios
 */
router.get('/users', authenticateToken, async (req: Request, res: Response) => {
  try {
    await authController.getAll(req, res);
  } catch (error) {
    res.status(500).json({ error: 'Error al obtener usuarios' });
  }
});

/**
 * @swagger
 * /api/auth/profile:
 *   get:
 *     summary: Obtener perfil del usuario actual
 *     tags: [Auth]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Perfil del usuario
 */
router.get('/profile', authenticateToken, (req: Request, res: Response) =>
  authController.getProfile(req, res),
);

/**
 * @swagger
 * /api/auth/profile:
 *   put:
 *     summary: Actualizar perfil del usuario
 *     tags: [Auth]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               username:
 *                 type: string
 *               email:
 *                 type: string
 *               nombreCompleto:
 *                 type: string
 *               direccion:
 *                 type: string
 *               telefono:
 *                 type: string
 *               cedula:
 *                 type: string
 *     responses:
 *       200:
 *         description: Perfil actualizado
 */
router.put('/profile', authenticateToken, (req: Request, res: Response) =>
  authController.update(req, res),
);

router.put('/users/rol', authenticateToken, (req: Request, res: Response) =>
  authController.updateRol(req, res),
);

router.put('/users/update-email', authenticateToken, (req: Request, res: Response) =>
  authController.updateEmail(req, res),
);

router.put('/users/update-password', authenticateToken, (req: Request, res: Response) =>
  authController.updatePassword(req, res),
);

router.put('/users/:id', authenticateToken, (req: Request, res: Response) =>
  authController.updateUserById(req, res),
);

router.delete('/users/:id', authenticateToken, (req: Request, res: Response) =>
  authController.deleteUser(req, res),
);

router.put('/users/:id/password', authenticateToken, (req: Request, res: Response) =>
  authController.updateUserPassword(req, res),
);

export default router;
