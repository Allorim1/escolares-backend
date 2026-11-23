import { Router } from 'express';
import multer from 'multer';
import { creditosController } from '../controllers/creditos.controller';
import { authenticateCreditoUser } from '../middlewares/creditos.middleware';
import { validateBody } from '../middlewares/validate.middleware';
import { CREDITO_DOCUMENTOS } from '../models';

const router = Router();

const uploadVerificacion = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024, files: CREDITO_DOCUMENTOS.length },
  fileFilter: (_req, file, cb) => {
    const permitidos = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'];
    if (permitidos.includes(file.mimetype)) cb(null, true);
    else cb(new Error('Tipo de archivo no permitido. Solo imágenes o PDF'));
  },
});

// Autenticación de la app (cuentas propias, separadas de la tienda web)
router.post('/auth/registro', validateBody({ nombre:{required:true,type:'string',minLength:2,maxLength:120}, apellido:{required:true,type:'string',minLength:2,maxLength:120}, email:{required:true,type:'string',pattern:/^[^\s@]+@[^\s@]+\.[^\s@]+$/}, password:{required:true,type:'string',minLength:6,maxLength:128}, telefono:{type:'string',maxLength:30}, cedula:{type:'string',maxLength:40} }), (req, res) => creditosController.register(req, res));
router.post('/auth/login', validateBody({ email:{required:true,type:'string',maxLength:120}, password:{required:true,type:'string',minLength:1,maxLength:128} }), (req, res) => creditosController.login(req, res));
router.post('/auth/olvide-password', validateBody({ email:{required:true,type:'string',maxLength:120} }), (req, res) => creditosController.olvidePassword(req, res));
router.post('/auth/restablecer-password', validateBody({ email:{required:true,type:'string',maxLength:120}, otp:{required:true,type:'string',minLength:4,maxLength:12}, newPassword:{required:true,type:'string',minLength:6,maxLength:128} }), (req, res) => creditosController.verificarOtpYRestablecer(req, res));

// Perfil del usuario en sesión
router.get('/me', authenticateCreditoUser, (req, res) => creditosController.me(req, res));
router.patch('/me/email', authenticateCreditoUser, validateBody({ email:{required:true,type:'string',pattern:/^[^\s@]+@[^\s@]+\.[^\s@]+$/}, password:{required:true,type:'string',minLength:1,maxLength:128} }), (req, res) => creditosController.actualizarEmail(req, res));
router.post('/me/password', authenticateCreditoUser, validateBody({ currentPassword:{required:true,type:'string',minLength:1,maxLength:128}, newPassword:{required:true,type:'string',minLength:6,maxLength:128} }), (req, res) => creditosController.cambiarPassword(req, res));
router.post('/me/push-token', authenticateCreditoUser, validateBody({ token:{required:true,type:'string',minLength:10,maxLength:500}, plataforma:{type:'string',maxLength:40} }), (req, res) => creditosController.registrarPushToken(req, res));
router.post('/me/tutorial-visto', authenticateCreditoUser, (req, res) => creditosController.marcarTutorialVisto(req, res));

// Parámetros del negocio y catálogo, visibles para cualquier cuenta con sesión
router.get('/reglas', authenticateCreditoUser, (req, res) => creditosController.reglas(req, res));
router.get('/productos', authenticateCreditoUser, (req, res) => creditosController.productos(req, res));

// Verificación de identidad
router.post(
  '/verificacion',
  authenticateCreditoUser,
  uploadVerificacion.fields(CREDITO_DOCUMENTOS.map((campo) => ({ name: campo, maxCount: 1 }))),
  (req, res) => creditosController.enviarVerificacion(req, res),
);
router.get('/verificacion/documentos/:campo', authenticateCreditoUser, (req, res) =>
  creditosController.documentoPropio(req, res),
);

// Créditos del usuario en sesión
router.get('/solicitudes', authenticateCreditoUser, (req, res) => creditosController.listarSolicitudes(req, res));
router.post('/solicitudes', authenticateCreditoUser, validateBody({ monto:{required:true,type:'number',min:0}, cuotas:{required:true,type:'number',min:1,max:120}, proposito:{type:'string',maxLength:500}, productoId:{type:'string',maxLength:120}, items:{type:'array'} }), (req, res) => creditosController.crearSolicitud(req, res));
router.post('/solicitudes/:id/aceptar', authenticateCreditoUser, (req, res) => creditosController.aceptarSolicitud(req, res));
router.post('/solicitudes/:id/rechazar', authenticateCreditoUser, (req, res) => creditosController.rechazarSolicitud(req, res));

// Abonos a una factura activa (Pago Móvil / Transferencia), pendientes de verificación del staff
router.post('/solicitudes/:id/pagos', authenticateCreditoUser, validateBody({ monto:{required:true,type:'number',min:0}, metodo:{required:true,type:'string',maxLength:60}, referencia:{type:'string',maxLength:120}, comprobante:{type:'string',maxLength:20000000}, fecha:{type:'string',maxLength:60} }), (req, res) => creditosController.crearPago(req, res));
router.get('/pagos/:id', authenticateCreditoUser, (req, res) => creditosController.obtenerPago(req, res));

// Solicitar (o cancelar) la eliminación de la propia cuenta; la revisa el staff.
router.post('/me/eliminacion', authenticateCreditoUser, (req, res) => creditosController.solicitarEliminacion(req, res));
router.delete('/me/eliminacion', authenticateCreditoUser, (req, res) => creditosController.cancelarSolicitudEliminacion(req, res));

// Centro de ayuda: tickets propios (consultas, o casos de pago atrasado que abrió el staff).
router.get('/tickets', authenticateCreditoUser, (req, res) => creditosController.listarTickets(req, res));
router.post('/tickets', authenticateCreditoUser, validateBody({ asunto:{required:true,type:'string',minLength:3,maxLength:200}, mensaje:{required:true,type:'string',minLength:1,maxLength:5000}, categoria:{type:'string',maxLength:80} }), (req, res) => creditosController.crearTicket(req, res));
router.get('/tickets/:id', authenticateCreditoUser, (req, res) => creditosController.obtenerTicket(req, res));
router.post('/tickets/:id/mensajes', authenticateCreditoUser, validateBody({ mensaje:{required:true,type:'string',minLength:1,maxLength:5000} }), (req, res) => creditosController.responderTicket(req, res));

export default router;
