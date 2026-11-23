import { Router } from 'express';
import { creditosAdminController as c } from '../controllers/creditos-admin.controller';
import { authenticateToken, requireRoot } from '../middlewares/auth.middleware';
import { requireCreditosPermiso } from '../middlewares/creditos.middleware';
import { validateBody } from '../middlewares/validate.middleware';

const router = Router();

// Todo este módulo requiere sesión de staff (panel admin) + el permiso 'creditos_gestionar'
router.use(authenticateToken, requireCreditosPermiso);

router.get('/usuarios', (req, res) => c.listarUsuarios(req, res));
// Antes de '/usuarios/:id': si no, ':id' atraparía la palabra 'buscar' como si fuera un id.
router.get('/usuarios/buscar', (req, res) => c.buscarUsuarios(req, res));
router.get('/usuarios/:id', (req, res) => c.obtenerUsuario(req, res));
router.get('/usuarios/:id/documentos/:campo', (req, res) => c.documentoUsuario(req, res));
router.post('/usuarios/:id/verificacion/aprobar', (req, res) => c.aprobarVerificacion(req, res));
router.post('/usuarios/:id/verificacion/rechazar', validateBody({ motivo:{required:true,type:'string',minLength:3,maxLength:500} }), (req, res) => c.rechazarVerificacion(req, res));
router.post('/usuarios/:id/eliminacion/aprobar', (req, res) => c.aprobarEliminacion(req, res));
router.post('/usuarios/:id/eliminacion/rechazar', validateBody({ motivo:{required:true,type:'string',minLength:3,maxLength:500} }), (req, res) => c.rechazarEliminacion(req, res));
router.post('/usuarios/:id/nivel', validateBody({ nivel:{required:true,type:'number',min:0,max:100} }), (req, res) => c.cambiarNivel(req, res));
router.post('/usuarios/:id/extension-credito', validateBody({ monto:{required:true,type:'number',min:0}, motivo:{type:'string',maxLength:500} }), (req, res) => c.actualizarExtensionCredito(req, res));
router.get('/usuarios/:id/puntualidad', (req, res) => c.puntualidad(req, res));

router.get('/ubicaciones', (req, res) => c.listarUbicaciones(req, res));
router.get('/eliminaciones', (req, res) => c.listarSolicitudesEliminacion(req, res));
router.get('/restablecimientos', (req, res) => c.listarSolicitudesRestablecimiento(req, res));
router.post('/usuarios/:id/restablecer-password', validateBody({ newPassword:{required:true,type:'string',minLength:6,maxLength:128} }), (req, res) => c.restablecerPassword(req, res));

router.post('/compras', validateBody({ usuarioId:{required:true,type:'string',minLength:1}, monto:{required:true,type:'number',min:0}, cuotas:{required:true,type:'number',min:1,max:120}, items:{type:'array'}, proposito:{type:'string',maxLength:500} }), (req, res) => c.registrarCompra(req, res));
// Asignar una compra sin QR, con el inicial ya decidido: solo root, no basta el permiso de créditos.
router.post('/compras/manual', requireRoot, validateBody({ usuarioId:{required:true,type:'string',minLength:1}, monto:{required:true,type:'number',min:0}, cuotas:{required:true,type:'number',min:1,max:120}, pagoInicial:{type:'number',min:0}, items:{type:'array'}, proposito:{type:'string',maxLength:500} }), (req, res) => c.registrarCompraManual(req, res));

router.get('/solicitudes', (req, res) => c.listarSolicitudes(req, res));
router.get('/solicitudes/:id', (req, res) => c.obtenerSolicitud(req, res));
router.post('/solicitudes/:id/aprobar', (req, res) => c.aprobarSolicitud(req, res));
router.post('/solicitudes/:id/rechazar', validateBody({ motivo:{required:true,type:'string',minLength:3,maxLength:500} }), (req, res) => c.rechazarSolicitud(req, res));
router.post('/solicitudes/:id/cancelar', validateBody({ motivo:{type:'string',maxLength:500} }), (req, res) => c.cancelarCompra(req, res));
router.post('/solicitudes/:id/confirmar-pago', validateBody({ monto:{type:'number',min:0}, referencia:{type:'string',maxLength:120}, nota:{type:'string',maxLength:500} }), (req, res) => c.confirmarPago(req, res));
router.post('/solicitudes/:id/registrar-pago', validateBody({ monto:{required:true,type:'number',min:0}, referencia:{type:'string',maxLength:120}, metodo:{type:'string',maxLength:60}, nota:{type:'string',maxLength:500} }), (req, res) => c.registrarPago(req, res));

// Abonos (Pago Móvil / Transferencia) declarados por los clientes, pendientes de verificar
router.get('/pagos', (req, res) => c.listarPagos(req, res));
router.post('/pagos/:id/verificar', (req, res) => c.verificarPago(req, res));
router.post('/pagos/:id/rechazar', validateBody({ motivo:{required:true,type:'string',minLength:3,maxLength:500} }), (req, res) => c.rechazarPago(req, res));

router.get('/productos', (req, res) => c.listarProductos(req, res));
router.post('/productos', validateBody({ nombre:{required:true,type:'string',minLength:2,maxLength:200}, descripcion:{type:'string',maxLength:2000}, precio:{required:true,type:'number',min:0}, activo:{type:'boolean'}, imagen:{type:'string',maxLength:20000000} }), (req, res) => c.crearProducto(req, res));
router.put('/productos/:id', validateBody({ nombre:{type:'string',minLength:2,maxLength:200}, descripcion:{type:'string',maxLength:2000}, precio:{type:'number',min:0}, activo:{type:'boolean'}, imagen:{type:'string',maxLength:20000000} }), (req, res) => c.actualizarProducto(req, res));
router.delete('/productos/:id', (req, res) => c.eliminarProducto(req, res));

router.get('/reportes', (req, res) => c.reportes(req, res));

router.get('/reglas', (req, res) => c.obtenerReglas(req, res));
router.put('/reglas', validateBody({}), (req, res) => c.actualizarReglas(req, res));

// Centro de ayuda: tickets de todos los clientes y casos de pago atrasado.
router.get('/tickets', (req, res) => c.listarTickets(req, res));
router.get('/tickets/:id', (req, res) => c.obtenerTicket(req, res));
router.post('/tickets/:id/mensajes', validateBody({ mensaje:{required:true,type:'string',minLength:1,maxLength:5000} }), (req, res) => c.responderTicket(req, res));
router.post('/tickets/:id/cerrar', (req, res) => c.cerrarTicket(req, res));
router.post('/tickets/pago-atrasado', validateBody({ usuarioId:{required:true,type:'string',minLength:1}, solicitudId:{type:'string',maxLength:120}, mensaje:{type:'string',maxLength:5000} }), (req, res) => c.abrirCasoPagoAtrasado(req, res));

export default router;
