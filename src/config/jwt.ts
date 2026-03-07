import jwt, { SignOptions } from 'jsonwebtoken';

const JWT_SECRET = process.env.JWT_SECRET || 'escolares-super-secret-key-change-in-production';
const JWT_REFRESH_SECRET =
  process.env.JWT_REFRESH_SECRET || 'escolares-refresh-secret-key-change-in-production';

export interface TokenPayload {
  userId: string;
  email: string;
  rol: string;
}

export const jwtConfig = {
  secret: JWT_SECRET,
  refreshSecret: JWT_REFRESH_SECRET,
  expiresIn: process.env.JWT_EXPIRES_IN || '15m',
  refreshExpiresIn: process.env.JWT_REFRESH_EXPIRES_IN || '7d',

  generateTokens(payload: TokenPayload): { accessToken: string; refreshToken: string } {
    const accessOptions: SignOptions = { expiresIn: '15m' };
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
