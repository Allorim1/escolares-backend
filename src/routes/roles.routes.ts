import { Router, Request, Response } from 'express';
import { database } from '../config/database';
import { authenticateToken } from '../middlewares/auth.middleware';
import { Rol } from '../models';

const router = Router();

const crearRegistro = async (accion: string, modulo: string, descripcion: string, datos: any, usuario: string) => {
  let registrosCollection = database.getCollection('registros');
  if (!registrosCollection) {
    await database.db.createCollection('registros');
    registrosCollection = database.getCollection('registros');
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
  { id: 'ver_productos', nombre: 'Ver Productos', descripcion: 'Puede ver la lista de productos', modulo: 'productos' },
  { id: 'crear_productos', nombre: 'Crear Productos', descripcion: 'Puede crear nuevos productos', modulo: 'productos' },
  { id: 'editar_productos', nombre: 'Editar Productos', descripcion: 'Puede editar productos existentes', modulo: 'productos' },
  { id: 'eliminar_productos', nombre: 'Eliminar Productos', descripcion: 'Puede eliminar productos', modulo: 'productos' },
  
  { id: 'ver_pedidos', nombre: 'Ver Pedidos', descripcion: 'Puede ver los pedidos de clientes', modulo: 'pedidos' },
  { id: 'gestionar_pedidos', nombre: 'Gestionar Pedidos', descripcion: 'Puede cambiar estado de pedidos', modulo: 'pedidos' },
  
  { id: 'ver_usuarios', nombre: 'Ver Usuarios', descripcion: 'Puede ver la lista de usuarios', modulo: 'usuarios' },
  { id: 'crear_usuarios', nombre: 'Crear Usuarios', descripcion: 'Puede crear nuevos usuarios', modulo: 'usuarios' },
  { id: 'editar_usuarios', nombre: 'Editar Usuarios', descripcion: 'Puede editar usuarios', modulo: 'usuarios' },
  { id: 'eliminar_usuarios', nombre: 'Eliminar Usuarios', descripcion: 'Puede eliminar usuarios', modulo: 'usuarios' },
  { id: 'gestionar_roles', nombre: 'Gestionar Roles', descripcion: 'Puede crear y editar roles', modulo: 'usuarios' },
  
  { id: 'ver_proveedores', nombre: 'Ver Proveedores', descripcion: ' Puede ver la lista de proveedores', modulo: 'proveedores' },
  { id: 'crear_proveedores', nombre: 'Crear Proveedores', descripcion: 'Puede crear proveedores', modulo: 'proveedores' },
  { id: 'editar_proveedores', nombre: 'Editar Proveedores', descripcion: 'Puede editar proveedores', modulo: 'proveedores' },
  { id: 'eliminar_proveedores', nombre: 'Eliminar Proveedores', descripcion: 'Puede eliminar proveedores', modulo: 'proveedores' },
  { id: 'gestionar_facturas', nombre: 'Gestionar Facturas', descripcion: 'Puede gestionar facturas de proveedores', modulo: 'proveedores' },
  
  { id: 'ver_inicio', nombre: 'Ver Gestión de Inicio', descripcion: 'Puede gestionar el contenido de la página de inicio', modulo: 'inicio' },
  { id: 'ver_reportes', nombre: 'Ver Reportes', descripcion: 'Puede ver reportes y estadísticas', modulo: 'reportes' },
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

router.get('/:id', authenticateToken, requireRoot, async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const rol = await database.getCollection<Rol>('roles').findOne({ id });

    if (!rol) {
      res.status(404).json({ error: 'Rol no encontrado' });
      return;
    }

    res.json(rol);
  } catch (error) {
    console.error('Error getting rol:', error);
    res.status(500).json({ error: 'Error al obtener rol' });
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
