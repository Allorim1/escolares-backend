import { Request, Response, NextFunction } from 'express';
import { jwtConfig, TokenPayload } from '../config/jwt';
import { database } from '../config/database';
import { CreditoUsuario, Rol, User } from '../models';

export interface CreditoAuthRequest extends Request {
  creditoUser?: TokenPayload;
}

/**
 * Autenticación de la app Escolares Online (Android). Son cuentas propias
 * (`creditos_usuarios`), separadas de las de la tienda web: el JWT usa el mismo
 * secreto que el resto del backend, pero con rol 'cliente_creditos' y sin las
 * cookies/sesiones del panel admin, que no aplican a la app.
 */
export const authenticateCreditoUser = async (
  req: CreditoAuthRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const token = req.headers.authorization?.replace('Bearer ', '');
    if (!token) {
      res.status(401).json({ error: 'Token de acceso requerido' });
      return;
    }

    const payload = jwtConfig.verifyAccessToken(token);
    if (!payload || payload.rol !== 'cliente_creditos') {
      res.status(401).json({ error: 'Token inválido o expirado' });
      return;
    }

    const usuario = await database.getCollection<CreditoUsuario>('creditos_usuarios').findOne({ id: payload.userId });
    if (!usuario) {
      res.status(401).json({ error: 'Usuario no encontrado' });
      return;
    }

    req.creditoUser = payload;
    next();
  } catch (error) {
    res.status(401).json({ error: 'Error de autenticación' });
  }
};

/**
 * Acceso de administradores al módulo "Créditos Escolares" del panel: requiere
 * sesión de staff válida (authenticateToken ya debe haber corrido antes) y el
 * permiso 'creditos_gestionar', salvo para root, que siempre pasa.
 */
export const requireCreditosPermiso = (
  req: Request,
  res: Response,
  next: NextFunction,
): void => {
  (async () => {
    const userRol = (req as any).userRol;
    if (userRol === 'root') {
      next();
      return;
    }

    const userId = (req as any).user?.userId;
    const usuario = userId ? await database.getCollection<User>('users').findOne({ id: userId }) : null;
    const rolId = usuario?.rolId;
    const rol = rolId ? await database.getCollection<Rol>('roles').findOne({ id: rolId }) : null;

    if (!rol?.permisos?.includes('creditos_gestionar')) {
      res.status(403).json({ error: 'No tienes permiso para acceder a Créditos Escolares' });
      return;
    }

    next();
  })().catch((error) => {
    console.error('Error verificando permiso de créditos:', error);
    res.status(500).json({ error: 'Error al verificar permisos' });
  });
};
