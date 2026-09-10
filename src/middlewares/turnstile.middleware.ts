import { Request, Response, NextFunction } from 'express';

const TURNSTILE_VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

interface TurnstileVerifyResponse {
  success: boolean;
  'error-codes'?: string[];
}

/**
 * Verifica el token de Cloudflare Turnstile enviado por el frontend antes de
 * dejar pasar la request al controlador (login/register).
 */
export const verifyTurnstile = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  const secret = process.env.TURNSTILE_SECRET;

  if (!secret) {
    if (process.env.NODE_ENV === 'production') {
      console.error('TURNSTILE_SECRET no está configurado');
      res.status(500).json({ error: 'Verificación de seguridad no disponible' });
      return;
    }
    // En desarrollo, si no hay secret configurado, no se bloquea el flujo.
    console.warn('TURNSTILE_SECRET no configurado: se omite la verificación de Turnstile (modo desarrollo)');
    next();
    return;
  }

  const token = req.body?.turnstileToken;
  if (!token || typeof token !== 'string') {
    res.status(400).json({ error: 'Verificación de seguridad requerida' });
    return;
  }

  try {
    const params = new URLSearchParams();
    params.append('secret', secret);
    params.append('response', token);
    const remoteIp = req.ip;
    if (remoteIp) params.append('remoteip', remoteIp);

    const verifyRes = await fetch(TURNSTILE_VERIFY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params,
    });

    const data = (await verifyRes.json()) as TurnstileVerifyResponse;

    if (!data.success) {
      console.warn('Verificación de Turnstile fallida:', data['error-codes']);
      res.status(403).json({ error: 'Verificación de seguridad fallida, intenta de nuevo' });
      return;
    }

    next();
  } catch (error) {
    console.error('Error al verificar Turnstile:', error);
    res.status(502).json({ error: 'No se pudo validar la verificación de seguridad' });
  }
};
