import crypto from 'crypto';
import { NextFunction, Request, Response } from 'express';
import { jwtConfig, TokenPayload } from '../config/jwt';
import { VinculoAutorizaciones, vinculoPorEscolares } from '../services/autorizaciones-vinculos.service';

function igualesSeguro(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

/**
 * Cajas de sellhub: cabecera x-api-key = AUTORIZACIONES_SELLHUB_API_KEY (la misma que
 * AUTORIZACION_MOVIL_API_KEY en sellhub/.env). Sin la variable, todo /caja queda cerrado.
 */
export function autenticarCaja(req: Request, res: Response, next: NextFunction): void {
  const esperada = process.env.AUTORIZACIONES_SELLHUB_API_KEY || '';
  const clave = req.header('x-api-key') ?? '';
  if (!esperada || !igualesSeguro(clave, esperada)) {
    res.status(401).json({ message: 'Clave de caja inválida' });
    return;
  }
  next();
}

export type RequestMovil = Request & {
  usuario?: TokenPayload;
  dispositivoId?: string;
  vinculo?: VinculoAutorizaciones;
};

export const nombreEscolares = (u: TokenPayload) => u.nombre || u.username || u.email || 'Usuario';

/**
 * App de supervisores: token de escolares (Authorization: Bearer, de /api/auth/login-app)
 * + el id de instalación que genera la app (cabecera x-dispositivo-id).
 */
export function autenticarMovil(req: RequestMovil, res: Response, next: NextFunction): void {
  const token = req.headers.authorization?.replace('Bearer ', '');
  const usuario = token ? jwtConfig.verifyAccessToken(token) : null;
  if (!usuario?.userId) {
    res.status(401).json({ message: 'Sesión vencida, vuelve a iniciar sesión' });
    return;
  }
  const dispositivoId = (req.header('x-dispositivo-id') ?? '').trim();
  if (!dispositivoId || dispositivoId.length > 100) {
    res.status(400).json({ message: 'Falta el identificador del celular' });
    return;
  }
  req.usuario = usuario;
  req.dispositivoId = dispositivoId;
  next();
}

/** Además de la sesión, exige que esta cuenta esté vinculada y precisamente en ESTE celular. */
export async function exigirVinculo(req: RequestMovil, res: Response, next: NextFunction): Promise<void> {
  const vinculo = await vinculoPorEscolares(req.usuario!.userId);
  if (!vinculo) {
    res.status(403).json({ message: 'Este celular no está vinculado', codigo: 'sin_vincular' });
    return;
  }
  if (vinculo.dispositivoId !== req.dispositivoId) {
    res.status(403).json({
      message: `Tu cuenta está vinculada en otro celular (${vinculo.dispositivoNombre})`,
      codigo: 'otro_dispositivo',
    });
    return;
  }
  req.vinculo = vinculo;
  next();
}
