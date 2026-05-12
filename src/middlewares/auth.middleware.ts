import { Request, Response, NextFunction } from 'express';
import { jwtConfig, TokenPayload } from '../config/jwt';

declare global {
  namespace Express {
    interface Request {
      user?: TokenPayload;
    }
  }
}

export interface AuthRequest extends Request {
  user?: TokenPayload;
}

export const authenticateToken = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const accessToken =
      req.cookies?.accessToken || req.headers.authorization?.replace('Bearer ', '');

    if (!accessToken) {
      res.status(401).json({ error: 'Token de acceso requerido' });
      return;
    }

    const payload = jwtConfig.verifyAccessToken(accessToken);
    if (!payload) {
      res.status(401).json({ error: 'Token inválido o expirado' });
      return;
    }

    req.user = payload;
    (req as any).userRol = payload.rol;
    next();
  } catch (error) {
    res.status(401).json({ error: 'Error de autenticación' });
  }
};

export const optionalAuth = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const accessToken =
      req.cookies?.accessToken || req.headers.authorization?.replace('Bearer ', '');

    if (accessToken) {
      const payload = jwtConfig.verifyAccessToken(accessToken);
      if (payload) {
        req.user = payload;
      }
    }
    next();
  } catch {
    next();
  }
};

export const requireRoot = (
  req: AuthRequest,
  res: Response,
  next: NextFunction,
): void => {
  const userRol = (req as any).userRol;
  if (userRol !== 'root') {
    res.status(403).json({ error: 'Solo el usuario root puede acceder a esta sección' });
    return;
  }
  next();
};
