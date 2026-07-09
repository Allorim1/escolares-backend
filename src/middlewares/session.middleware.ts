import { Request, Response, NextFunction } from 'express';
import { database } from '../config/database';
import { UserSession } from '../models';

const sessionMap = new Map<string, string>();

export const trackSession = (req: Request, res: Response, next: NextFunction): void => {
  const user = (req as any).user as { userId?: string; email?: string; rol?: string } | undefined;
  if (!user?.userId) {
    next();
    return;
  }

  const sessionId = req.cookies?.accessToken
    ? `sess_${Buffer.from(req.cookies.accessToken).toString('base64').slice(0, 32)}`
    : req.headers.authorization
      ? `sess_${Buffer.from(req.headers.authorization.replace('Bearer ', '')).toString('base64').slice(0, 32)}`
      : `sess_${Date.now()}_${Math.random().toString(36).substring(2, 15)}`;

  sessionMap.set(user.userId, sessionId);
  (req as any).sessionId = sessionId;

  updateSessionInBackground(user.userId, sessionId, user, req);

  next();
};

const updateSessionInBackground = async (
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
    };
    await sessionsCollection.insertOne(newSession);
  } catch (error) {
    console.error('Error creating session record:', error);
  }
};
