import { Router } from 'express';
import { creditosAdminController as c } from '../controllers/creditos-admin.controller';
import { authenticateToken } from '../middlewares/auth.middleware';
import { requireCreditosPermiso } from '../middlewares/creditos.middleware';

const router = Router();

// Todo este módulo requiere sesión de staff (panel admin) + el permiso 'creditos_gestionar'
router.use(authenticateToken, requireCreditosPermiso);

router.get('/usuarios', (req, res) => c.listarUsuarios(req, res));
// Antes de '/usuarios/:id': si no, ':id' atraparía la palabra 'buscar' como si fuera un id.
router.get('/usuarios/buscar', (req, res) => c.buscarUsuarios(req, res));
router.get('/usuarios/:id', (req, res) => c.obtenerUsuario(req, res));
router.get('/usuarios/:id/documentos/:campo', (req, res) => c.documentoUsuario(req, res));
router.post('/usuarios/:id/verificacion/aprobar', (req, res) => c.aprobarVerificacion(req, res));
router.post('/usuarios/:id/verificacion/rechazar', (req, res) => c.rechazarVerificacion(req, res));
router.post('/usuarios/:id/nivel', (req, res) => c.cambiarNivel(req, res));
router.post('/usuarios/:id/extension-credito', (req, res) => c.actualizarExtensionCredito(req, res));
router.get('/usuarios/:id/puntualidad', (req, res) => c.puntualidad(req, res));

router.get('/ubicaciones', (req, res) => c.listarUbicaciones(req, res));

router.post('/compras', (req, res) => c.registrarCompra(req, res));

router.get('/solicitudes', (req, res) => c.listarSolicitudes(req, res));
router.get('/solicitudes/:id', (req, res) => c.obtenerSolicitud(req, res));
router.post('/solicitudes/:id/aprobar', (req, res) => c.aprobarSolicitud(req, res));
router.post('/solicitudes/:id/rechazar', (req, res) => c.rechazarSolicitud(req, res));
router.post('/solicitudes/:id/cancelar', (req, res) => c.cancelarCompra(req, res));
router.post('/solicitudes/:id/confirmar-pago', (req, res) => c.confirmarPago(req, res));
router.post('/solicitudes/:id/registrar-pago', (req, res) => c.registrarPago(req, res));

// Abonos (Pago Móvil / Transferencia) declarados por los clientes, pendientes de verificar
router.get('/pagos', (req, res) => c.listarPagos(req, res));
router.post('/pagos/:id/verificar', (req, res) => c.verificarPago(req, res));
router.post('/pagos/:id/rechazar', (req, res) => c.rechazarPago(req, res));

router.get('/productos', (req, res) => c.listarProductos(req, res));
router.post('/productos', (req, res) => c.crearProducto(req, res));
router.put('/productos/:id', (req, res) => c.actualizarProducto(req, res));
router.delete('/productos/:id', (req, res) => c.eliminarProducto(req, res));

router.get('/reglas', (req, res) => c.obtenerReglas(req, res));
router.put('/reglas', (req, res) => c.actualizarReglas(req, res));

export default router;
