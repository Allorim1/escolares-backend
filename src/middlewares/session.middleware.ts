import { Request, Response, NextFunction } from 'express';
import { database } from '../config/database';
import { UserSession } from '../models';

const sessionMap = new Map<string, string>();

// Debe coincidir con la duración del accessToken (ver jwtConfig.generateTokens)
export const SESSION_TTL_MS = 24 * 60 * 60 * 1000;

export const trackSession = (req: Request, res: Response, next: NextFunction): void => {
  const user = (req as any).user as { userId?: string; email?: string; rol?: string; sessionId?: string } | undefined;
  if (!user?.userId) {
    next();
    return;
  }

  // authenticateToken (que corre antes en la cadena de middlewares) ya
  // calculó el sessionId real del token; lo reutilizamos en vez de
  // recalcularlo para no divergir del id bajo el que se creó la sesión.
  const sessionId =
    (req as any).sessionId || user.sessionId || `sess_${Date.now()}_${Math.random().toString(36).substring(2, 15)}`;

  sessionMap.set(user.userId, sessionId);
  (req as any).sessionId = sessionId;

  touchSessionActivity(user.userId, sessionId, user, req);

  next();
};

// Actualiza lastActive/IP/dispositivo de la sesión asociada a este request.
// Se llama en cada request autenticado (ver authenticateToken) para que
// "última actividad" refleje uso real y no solo el momento del login.
export const touchSessionActivity = async (
  userId: string,
  sessionId: string,
  user: { userId?: string; email?: string; rol?: string },
  req: Request,
): Promise<void> => {
  try {
    const ip = req.ip || req.socket.remoteAddress || 'unknown';
    const userAgent = req.headers['user-agent'] || '';
    const device = detectDevice(userAgent);
    const browser = detectBrowser(userAgent);
    const os = detectOS(userAgent);

    const sessionsCollection = database.getCollection<UserSession>('sessions');
    const existingSession = await sessionsCollection.findOne({ id: sessionId });

    if (existingSession) {
      await sessionsCollection.updateOne(
        { id: sessionId },
        {
          $set: {
            lastActive: new Date(),
            ip,
            userAgent,
            device,
            browser,
            os,
            active: true,
            // Ventana deslizante: mientras haya actividad, la sesión se mantiene
            // vigente; también rellena expiresAt en sesiones creadas antes de
            // que este campo existiera.
            expiresAt: new Date(Date.now() + SESSION_TTL_MS),
          },
        },
      );
    } else {
      const newSession: UserSession = {
        id: sessionId,
        userId,
        username: user.email?.split('@')[0] || userId,
        email: user.email || '',
        rol: user.rol || 'usuario',
        ip,
        userAgent,
        device,
        browser,
        os,
        active: true,
        createdAt: new Date(),
        lastActive: new Date(),
        expiresAt: new Date(Date.now() + SESSION_TTL_MS),
      };
      await sessionsCollection.insertOne(newSession);
    }
  } catch (error) {
    console.error('Error updating session:', error);
  }
};

const detectDevice = (userAgent: string): string => {
  const ua = userAgent.toLowerCase();
  if (ua.includes('mobile') || ua.includes('android') || ua.includes('iphone')) {
    return 'Móvil';
  }
  if (ua.includes('tablet') || ua.includes('ipad')) {
    return 'Tablet';
  }
  return 'Escritorio';
};

const detectBrowser = (userAgent: string): string => {
  const ua = userAgent.toLowerCase();
  if (ua.includes('chrome') && !ua.includes('edg')) return 'Chrome';
  if (ua.includes('firefox')) return 'Firefox';
  if (ua.includes('safari') && !ua.includes('chrome')) return 'Safari';
  if (ua.includes('edg')) return 'Edge';
  if (ua.includes('opera') || ua.includes('opr')) return 'Opera';
  return 'Desconocido';
};

const detectOS = (userAgent: string): string => {
  const ua = userAgent.toLowerCase();
  if (ua.includes('windows')) return 'Windows';
  if (ua.includes('mac') || ua.includes('macos')) return 'macOS';
  if (ua.includes('linux')) return 'Linux';
  if (ua.includes('android')) return 'Android';
  if (ua.includes('iphone') || ua.includes('ipad') || ua.includes('ios')) return 'iOS';
  return 'Desconocido';
};

export const createSessionRecord = async (
  userId: string,
  username: string,
  email: string,
  rol: string,
  sessionId: string,
  req: Request,
): Promise<void> => {
  try {
    const ip = req.ip || req.socket.remoteAddress || 'unknown';
    const userAgent = req.headers['user-agent'] || '';
    const device = detectDevice(userAgent);
    const browser = detectBrowser(userAgent);
    const os = detectOS(userAgent);

    const sessionsCollection = database.getCollection<UserSession>('sessions');
    const existingSession = await sessionsCollection.findOne({ id: sessionId });

    if (existingSession) {
      await sessionsCollection.updateOne(
        { id: sessionId },
        { $set: { lastActive: new Date(), ip, userAgent, device, browser, os, active: true } },
      );
    } else {
      const newSession: UserSession = {
        id: sessionId,
        userId,
        username,
        email,
        rol,
        ip,
        userAgent,
        device,
        browser,
        os,
        active: true,
        createdAt: new Date(),
        lastActive: new Date(),
        expiresAt: new Date(Date.now() + SESSION_TTL_MS),
      };
      await sessionsCollection.insertOne(newSession);
    }
  } catch (error) {
    console.error('Error creating session record:', error);
  }
};
