import { Router, Request, Response } from 'express';
import rateLimit from 'express-rate-limit';
import { authController } from '../controllers/auth.controller';
import { authenticateToken, requireRoot } from '../middlewares/auth.middleware';
import { trackSession } from '../middlewares/session.middleware';
import { verifyTurnstile } from '../middlewares/turnstile.middleware';
import { validateBody } from '../middlewares/validate.middleware';
import { database } from '../config/database';

const router = Router();

// Por defecto express-rate-limit cuenta los intentos solo por IP. Como varias
// personas pueden compartir la misma IP pública (red de oficina/escuela, o un
// proxy delante del backend), eso agotaba el cupo para todos a la vez aunque
// solo una cuenta estuviera fallando. Al combinar IP + identificador de la
// cuenta, el límite vuelve a ser por (IP, cuenta) como se pretendía.
const authKeyGenerator = (req: Request): string => {
  const identifier = (req.body?.email || req.body?.username || '').toString().toLowerCase().trim();
  return identifier ? `${req.ip}:${identifier}` : req.ip || 'sin-ip';
};

// 10 fallos/15min resultaba muy fácil de agotar con una contraseña vieja autocompletada
// por el navegador (cada intento fallido cuenta, aunque el siguiente sea el correcto).
// Cada intento ya exige pasar Cloudflare Turnstile, así que subir el cupo no debilita
// mucho la protección contra fuerza bruta.
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  skipSuccessfulRequests: true,
  keyGenerator: authKeyGenerator,
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
router.post('/register', authLimiter, verifyTurnstile, validateBody({ username:{required:true,type:'string',minLength:2,maxLength:80}, email:{required:true,type:'string',pattern:/^[^\s@]+@[^\s@]+\.[^\s@]+$/}, password:{required:true,type:'string',minLength:6,maxLength:128}, rif:{required:true,type:'string',minLength:3,maxLength:40}, telefono:{required:true,type:'string',minLength:7,maxLength:30}, direccion:{required:true,type:'string',minLength:3,maxLength:300}, tipoPersona:{type:'string',enum:['natural','juridica']}, turnstileToken:{type:'string'} }), (req: Request, res: Response) => authController.register(req, res));

router.post('/register-simple', authenticateToken, requireRoot, trackSession, validateBody({ username:{required:true,type:'string',minLength:2,maxLength:80}, email:{required:true,type:'string',pattern:/^[^\s@]+@[^\s@]+\.[^\s@]+$/}, password:{required:true,type:'string',minLength:6,maxLength:128}, nombreCompleto:{type:'string',maxLength:120}, apellido:{type:'string',maxLength:120}, telefono:{type:'string',maxLength:30}, direccion:{type:'string',maxLength:300}, comentarios:{type:'string',maxLength:1000}, rol:{type:'string',enum:['usuario','repartidor','root','admin']}, rolId:{type:'string',maxLength:120} }), (req: Request, res: Response) => authController.registerSimple(req, res));

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
router.post('/login', authLimiter, verifyTurnstile, validateBody({ email:{type:'string',maxLength:120}, username:{type:'string',maxLength:120}, password:{required:true,type:'string',minLength:1,maxLength:128}, turnstileToken:{type:'string'}, customCheck:{custom:(_v: unknown,b: any)=> (b.email||b.username)?null:'email o username es requerido'} }), (req: Request, res: Response) => authController.login(req, res));

// Login para apps nativas (p. ej. ion/escolares-pro): Turnstile es un captcha web
// y no se puede resolver desde una app, así que aquí se compensa con límites más
// estrictos: pocos fallos por cuenta y un tope por IP sin importar la cuenta,
// contra el relleno de credenciales. Mismo controlador y mismos tokens que /login.
const appLoginCuentaLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 5,
  skipSuccessfulRequests: true,
  keyGenerator: authKeyGenerator,
  message: { error: 'Demasiados intentos, intente en 15 minutos' },
  standardHeaders: true,
  legacyHeaders: false,
});
const appLoginIpLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 30,
  message: { error: 'Demasiados intentos desde esta red, intente en 15 minutos' },
  standardHeaders: true,
  legacyHeaders: false,
});
router.post('/login-app', appLoginIpLimiter, appLoginCuentaLimiter, validateBody({ email:{type:'string',maxLength:120}, username:{type:'string',maxLength:120}, password:{required:true,type:'string',minLength:1,maxLength:128}, customCheck:{custom:(_v: unknown,b: any)=> (b.email||b.username)?null:'email o username es requerido'} }), (req: Request, res: Response) => authController.login(req, res));

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
router.get('/users', authenticateToken, requireRoot, trackSession, async (req: Request, res: Response) => {
  try {
    await authController.getAll(req, res);
  } catch (error) {
    res.status(500).json({ error: 'Error al obtener usuarios' });
  }
});

router.get('/profile', authenticateToken, trackSession, (req: Request, res: Response) =>
  authController.getProfile(req, res),
);

router.put('/profile', authenticateToken, trackSession, (req: Request, res: Response) =>
  authController.update(req, res),
);

router.put('/users/rol', authenticateToken, requireRoot, trackSession, validateBody({ targetUserId:{required:true,type:'string',minLength:1}, rol:{type:'string',enum:['usuario','repartidor','root','admin']}, rolId:{type:'string',maxLength:120}, customCheck:{custom:(_v: unknown,b: any)=> (b.rol||b.rolId)?null:'rol o rolId es requerido'} }), (req: Request, res: Response) =>
  authController.updateRol(req, res),
);

router.put('/users/update-email', authenticateToken, trackSession, validateBody({ email:{required:true,type:'string',pattern:/^[^\s@]+@[^\s@]+\.[^\s@]+$/}, password:{required:true,type:'string',minLength:1,maxLength:128} }), (req: Request, res: Response) =>
  authController.updateEmail(req, res),
);

router.put('/users/update-password', authenticateToken, trackSession, validateBody({ currentPassword:{required:true,type:'string',minLength:1,maxLength:128}, newPassword:{required:true,type:'string',minLength:6,maxLength:128} }), (req: Request, res: Response) =>
  authController.updatePassword(req, res),
);

router.put('/users/:id', authenticateToken, requireRoot, trackSession, (req: Request, res: Response) =>
  authController.updateUserById(req, res),
);

router.delete('/users/:id', authenticateToken, requireRoot, trackSession, (req: Request, res: Response) =>
  authController.deleteUser(req, res),
);

router.put('/users/:id/password', authenticateToken, requireRoot, trackSession, validateBody({ newPassword:{required:true,type:'string',minLength:6,maxLength:128} }), (req: Request, res: Response) =>
  authController.updateUserPassword(req, res),
);

// Recovery routes
const recoveryLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 5,
  message: { error: 'Demasiados intentos, intente en 15 minutos' },
  standardHeaders: true,
  legacyHeaders: false,
});
router.post('/recover-username', recoveryLimiter, validateBody({ email:{required:true,type:'string',minLength:2,maxLength:120} }), (req: Request, res: Response) =>
  authController.recoverUsername(req, res),
);

router.post('/send-otp', recoveryLimiter, validateBody({ usernameOrEmail:{required:true,type:'string',minLength:2,maxLength:120} }), (req: Request, res: Response) =>
  authController.sendOtpForPasswordReset(req, res),
);

router.post('/reset-password', recoveryLimiter, validateBody({ usernameOrEmail:{required:true,type:'string',minLength:2,maxLength:120}, otp:{required:true,type:'string',minLength:4,maxLength:12}, newPassword:{required:true,type:'string',minLength:6,maxLength:128} }), (req: Request, res: Response) =>
  authController.verifyOtpAndResetPassword(req, res),
);

router.get('/sessions', authenticateToken, requireRoot, trackSession, (req: Request, res: Response) =>
  authController.getAllSessions(req, res),
);

router.get('/sessions/mine', authenticateToken, trackSession, (req: Request, res: Response) =>
  authController.getMySessions(req, res),
);

router.delete('/sessions/:sessionId', authenticateToken, trackSession, (req: Request, res: Response) =>
  authController.terminateSession(req, res),
);

router.delete('/sessions/user/:userId', authenticateToken, requireRoot, trackSession, (req: Request, res: Response) =>
  authController.terminateAllUserSessions(req, res),
);

router.get('/passwords', authenticateToken, requireRoot, trackSession, (req: Request, res: Response) =>
  authController.getAllPasswords(req, res),
);

router.delete('/passwords/:id', authenticateToken, requireRoot, trackSession, (req: Request, res: Response) =>
  authController.deletePassword(req, res),
);

export default router;