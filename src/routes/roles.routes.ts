import { Router, Request, Response } from 'express';
import { database } from '../config/database';
import { authenticateToken } from '../middlewares/auth.middleware';
import { Rol } from '../models';

const router = Router();

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

const isRoot = (req: Request): boolean => {
  const userRol = (req as any).userRol;
  return userRol === 'root';
};

const requireRoot = (req: Request, res: Response, next: () => void) => {
  const userRol = (req as any).userRol;
  console.log('requireRoot - userRol:', userRol, 'isRoot:', isRoot(req));
  if (!isRoot(req)) {
    res.status(403).json({ error: 'Solo el usuario root puede acceder a esta sección', debug: { userRol } });
    return;
  }
  next();
};

const DEFAULT_PERMISOS: { id: string; nombre: string; descripcion: string; modulo: string }[] = [
  // Panel Admin - Pedidos
  { id: 'pedidos_ver', nombre: 'Ver Pedidos', descripcion: 'Puede ver los pedidos', modulo: 'panel_admin' },
  
  // Panel Admin - Costos y Tasas
  { id: 'tasas_gestionar', nombre: 'Gestionar Tasas', descripcion: 'Puede gestionar costos y tasas', modulo: 'panel_admin' },
  { id: 'tasas_ver', nombre: 'Ver Tasas', descripcion: 'Puede ver histórico de costos', modulo: 'panel_admin' },
  
  // Panel Admin - Registro/Facturación
  { id: 'facturas_registrar', nombre: 'Registrar Facturas', descripcion: 'Puede registrar facturas', modulo: 'panel_admin' },
  { id: 'facturas_gestionar', nombre: 'Gestionar Facturas', descripcion: 'Puede gestionar facturación', modulo: 'panel_admin' },
  
  // Panel Admin - Otros
  { id: 'gastos_gestionar', nombre: 'Gestionar Gastos', descripcion: 'Puede gestionar gastos', modulo: 'panel_admin' },
  { id: 'nomina_ver', nombre: 'Ver Nómina', descripcion: 'Puede ver nómina', modulo: 'panel_admin' },
  { id: 'documentos_ver', nombre: 'Ver Galería de Documentos', descripcion: 'Puede ver documentos', modulo: 'panel_admin' },
  { id: 'conversion_gestionar', nombre: 'Gestionar Conversión', descripcion: 'Puede gestionar conversión', modulo: 'panel_admin' },
  { id: 'chat_ver', nombre: 'Ver Chat', descripcion: 'Puede acceder al chat', modulo: 'panel_admin' },
  { id: 'caja_ver', nombre: 'Ver Cierre de Caja', descripcion: 'Puede ver cierre de caja', modulo: 'panel_admin' },
  
  // Cuentas por Pagar
  { id: 'ver_proveedores', nombre: 'Ver Proveedores', descripcion: 'Puede ver proveedores', modulo: 'cuentas_por_pagar' },
  { id: 'ver_retenciones', nombre: 'Ver Retenciones', descripcion: 'Puede ver retenciones', modulo: 'cuentas_por_pagar' },
  { id: 'ver_libro_compras', nombre: 'Ver Libro de Compras', descripcion: 'Puede ver libro de compras', modulo: 'cuentas_por_pagar' },
  
  // Panel Web - Inicio
  { id: 'inicio_gestionar', nombre: 'Gestionar Inicio', descripcion: 'Puede gestionar página de inicio', modulo: 'panel_web' },
  
  // Panel Web - Catálogo
  { id: 'productos_gestionar', nombre: 'Gestionar Productos', descripcion: 'Puede gestionar productos', modulo: 'panel_web' },
  { id: 'marcas_ver', nombre: 'Ver Marcas', descripcion: 'Puede ver marcas', modulo: 'panel_web' },
  { id: 'lineas_ver', nombre: 'Ver Líneas', descripcion: 'Puede ver líneas', modulo: 'panel_web' },
  { id: 'ofertas_ver', nombre: 'Ver Ofertas', descripcion: 'Puede ver ofertas', modulo: 'panel_web' },
  
  // Panel Web - Usuarios y Roles
  { id: 'usuarios_gestionar', nombre: 'Gestionar Usuarios', descripcion: 'Puede gestionar usuarios', modulo: 'panel_web' },
  { id: 'roles_gestionar', nombre: 'Gestionar Roles', descripcion: 'Puede gestionar roles', modulo: 'panel_web' },
  
  // Panel Web - Manuales
  { id: 'manuales_ver', nombre: 'Ver Manuales', descripcion: 'Puede ver manuales', modulo: 'panel_web' },
];

router.get('/permisos', authenticateToken, requireRoot, async (req: Request, res: Response) => {
  try {
    res.json(DEFAULT_PERMISOS);
  } catch (error) {
    console.error('Error getting permisos:', error);
    res.status(500).json({ error: 'Error al obtener permisos' });
  }
});

router.get('/', authenticateToken, requireRoot, async (req: Request, res: Response) => {
  try {
    const roles = await database.getCollection<Rol>('roles').find({}).toArray();
    res.json(roles);
  } catch (error) {
    console.error('Error getting roles:', error);
    res.status(500).json({ error: 'Error al obtener roles' });
  }
});

router.get('/:id', authenticateToken, async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const userRol = (req as any).userRol;
    const userId = (req as any).user?.id || (req as any).user?._id;

    console.log('GET /roles/:id - id:', id, 'userRol:', userRol, 'userId:', userId);

    // Si no es root, verificar que el usuario solo acceda a su propio rol
    if (userRol !== 'root') {
      // Buscar el usuario para verificar su rolId
      const user = await database.getCollection('users').findOne({ id: userId });
      console.log('Usuario encontrado:', user?.username, 'rolId:', user?.rolId);
      
      if (!user || user.rolId !== id) {
        res.status(403).json({ error: 'No tienes permisos para ver este rol', debug: { userRolId: user?.rolId, requestedId: id } });
        return;
      }
    }

    const rol = await database.getCollection<Rol>('roles').findOne({ id });

    if (!rol) {
      console.log('Rol no encontrado con id:', id);
      res.status(404).json({ error: 'Rol no encontrado', id });
      return;
    }

    console.log('Rol enviado:', rol.nombre, 'permisos:', rol.permisos);
    res.json(rol);
  } catch (error) {
    console.error('Error getting rol:', error);
    res.status(500).json({ error: 'Error al obtener rol', details: error instanceof Error ? error.message : error });
  }
});

router.post('/', authenticateToken, requireRoot, async (req: Request, res: Response) => {
  try {
    const { nombre, descripcion, permisos, esDefault, esVendedor, comision } = req.body;
    const usuario = req.user?.nombre || req.user?.username || req.user?.email || 'Sistema';

    if (!nombre) {
      res.status(400).json({ error: 'El nombre del rol es requerido' });
      return;
    }

    const existingRol = await database.getCollection<Rol>('roles').findOne({ nombre });
    if (existingRol) {
      res.status(400).json({ error: 'Ya existe un rol con ese nombre' });
      return;
    }

    const newRol: Rol = {
      id: Date.now().toString(),
      nombre,
      descripcion: descripcion || '',
      permisos: permisos || [],
      esDefault: esDefault || false,
      esVendedor: esVendedor || false,
      comision: comision || 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    await database.getCollection<Rol>('roles').insertOne(newRol);

    await crearRegistro('Creación', 'Roles', `Rol creado: ${nombre}`, { rol: newRol }, usuario);

    res.status(201).json(newRol);
  } catch (error) {
    console.error('Error creating rol:', error);
    res.status(500).json({ error: 'Error al crear rol' });
  }
});

router.put('/:id', authenticateToken, requireRoot, async (req: Request, res: Response) => {
  try {
    const solicitanteRol = (req as any).userRol;
    const usuario = req.user?.nombre || req.user?.username || req.user?.email || 'Sistema';
    
    if (solicitanteRol !== 'root') {
      res.status(403).json({ error: 'No tienes permisos para editar roles' });
      return;
    }

    const { id } = req.params;
    const { nombre, descripcion, permisos, esDefault, esVendedor, comision } = req.body;

    const existingRolById = await database.getCollection<Rol>('roles').findOne({ id });
    if (!existingRolById) {
      res.status(404).json({ error: 'Rol no encontrado' });
      return;
    }

    if (existingRolById.nombre === 'root' || existingRolById.nombre === 'owner') {
      res.status(400).json({ error: 'No puedes editar roles del sistema' });
      return;
    }

    const updateData: Partial<Rol> = {};
    if (nombre !== undefined) updateData.nombre = nombre;
    if (descripcion !== undefined) updateData.descripcion = descripcion;
    if (permisos !== undefined) updateData.permisos = permisos;
    if (esDefault !== undefined) updateData.esDefault = esDefault;
    if (esVendedor !== undefined) updateData.esVendedor = esVendedor;
    if (comision !== undefined) updateData.comision = comision;

    const result = await database.getCollection<Rol>('roles').findOneAndUpdate(
      { id },
      { $set: updateData },
      { returnDocument: 'after' }
    );

    await crearRegistro('Modificación', 'Roles', `Rol modificado: ${existingRolById.nombre}`, { rolAnterior: existingRolById, rolNuevo: result }, usuario);

    res.json(result);
  } catch (error) {
    console.error('Error updating rol:', error);
    res.status(500).json({ error: 'Error al actualizar rol' });
  }
});

router.delete('/:id', authenticateToken, requireRoot, async (req: Request, res: Response) => {
  try {
    const solicitanteRol = (req as any).userRol;
    const usuario = req.user?.nombre || req.user?.username || req.user?.email || 'Sistema';
    
    if (solicitanteRol !== 'root') {
      res.status(403).json({ error: 'Solo el usuario root puede eliminar roles' });
      return;
    }

    const { id } = req.params;

    const existingRol = await database.getCollection<Rol>('roles').findOne({ id });
    if (!existingRol) {
      res.status(404).json({ error: 'Rol no encontrado' });
      return;
    }

    if (existingRol.nombre === 'root' || existingRol.nombre === 'owner') {
      res.status(400).json({ error: 'No puedes eliminar el rol de owner' });
      return;
    }

    if (existingRol.esDefault) {
      res.status(400).json({ error: 'No puedes eliminar un rol por defecto' });
      return;
    }

    await database.getCollection<Rol>('roles').deleteOne({ id });

    await crearRegistro('Eliminación', 'Roles', `Rol eliminado: ${existingRol.nombre}`, { rol: existingRol }, usuario);

    res.json({ success: true, message: 'Rol eliminado correctamente' });
  } catch (error) {
    console.error('Error deleting rol:', error);
    res.status(500).json({ error: 'Error al eliminar rol' });
  }
});

export default router;
