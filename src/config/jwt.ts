import jwt, { SignOptions } from 'jsonwebtoken';

const JWT_SECRET = process.env.JWT_SECRET;
const JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET;

if (!JWT_SECRET || !JWT_REFRESH_SECRET) {
  throw new Error('JWT_SECRET y JWT_REFRESH_SECRET deben estar configurados en variables de entorno');
}

export interface TokenPayload {
   userId: string;
   email: string;
   rol: string;
   username?: string;
   nombre?: string;
   deliveryPersonId?: string;
 }

export const jwtConfig = {
  secret: JWT_SECRET,
  refreshSecret: JWT_REFRESH_SECRET,
  expiresIn: process.env.JWT_EXPIRES_IN || '24h',
  refreshExpiresIn: process.env.JWT_REFRESH_EXPIRES_IN || '7d',

  generateTokens(payload: TokenPayload): { accessToken: string; refreshToken: string } {
    const accessOptions: SignOptions = { expiresIn: '24h' };
    const refreshOptions: SignOptions = { expiresIn: '7d' };

    const accessToken = jwt.sign(payload, this.secret, accessOptions);
    const refreshToken = jwt.sign(payload, this.refreshSecret, refreshOptions);
    return { accessToken, refreshToken };
  },

  verifyAccessToken(token: string): TokenPayload | null {
    try {
      return jwt.verify(token, this.secret) as TokenPayload;
    } catch (error) {
      return null;
    }
  },

  verifyRefreshToken(token: string): TokenPayload | null {
    try {
      return jwt.verify(token, this.refreshSecret) as TokenPayload;
    } catch (error) {
      return null;
    }
  },

  generateSessionId(): string {
    return `sess_${Date.now()}_${Math.random().toString(36).substring(2, 15)}`;
  },
};
