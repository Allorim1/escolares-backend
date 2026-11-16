import { NextFunction, Request, Response } from 'express';
import { jwtConfig, TokenPayload } from '../config/jwt';
import { tocarSecundario } from '../services/autorizaciones-dispositivos.service';
import { prepararMultitienda, Tienda, tiendaPorClave } from '../services/autorizaciones-tiendas.service';
import {
  DispositivoSecundario,
  secundarioPorDispositivo,
  VinculoAutorizaciones,
  vinculosPorEscolares,
} from '../services/autorizaciones-vinculos.service';

/** Índices, migración a multitienda y caché de tiendas antes de atender cualquier ruta. */
export async function esperarMultitienda(_req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    await prepararMultitienda();
    next();
  } catch (error) {
    console.error('Autorizaciones: no se pudo preparar multitienda:', error);
    res.status(503).json({ message: 'El servicio se está iniciando, intenta de nuevo en unos segundos' });
  }
}

export type RequestCaja = Request & { tienda?: Tienda };

/**
 * Cajas de sellhub: cabecera x-api-key = la clave de SU tienda (AUTORIZACION_MOVIL_API_KEY
 * en el .env del servidor de esa tienda). Las claves se crean en Gestión Multienda.
 */
export async function autenticarCaja(req: RequestCaja, res: Response, next: NextFunction): Promise<void> {
  try {
    await prepararMultitienda();
    const tienda = await tiendaPorClave(req.header('x-api-key') ?? '');
    if (!tienda) {
      res.status(401).json({ message: 'Clave de caja inválida' });
      return;
    }
    req.tienda = tienda;
    next();
  } catch (error) {
    next(error);
  }
}

export type RequestMovil = Request & {
  usuario?: TokenPayload;
  dispositivoId?: string;
  /** Todos los vínculos de la cuenta (uno por tienda) que este celular puede usar. */
  vinculos?: VinculoAutorizaciones[];
  /** Ids internos (`tienda:usuario`) de esos vínculos. */
  usuarios?: string[];
  /**
   * El vínculo de la tienda con la que se opera: la que pide la app (cabecera x-tienda-id o
   * ?tienda=) o, si no dice (versiones viejas de la app), la primera.
   */
  vinculo?: VinculoAutorizaciones;
  /** Si el que llama es un celular secundario (vinculado por QR), su registro. */
  secundario?: DispositivoSecundario;
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

/** Tienda que pide la app para esta llamada (vacío = no dijo). */
const tiendaPedida = (req: Request): string => {
  const valor = req.header('x-tienda-id') ?? (typeof req.query.tienda === 'string' ? req.query.tienda : '');
  return valor.trim().slice(0, 60);
};

/**
 * Además de la sesión, exige que la cuenta esté vinculada en al menos una tienda y que ESTE
 * celular sea su principal o uno de sus secundarios. Deja en el request los vínculos y el
 * de la tienda pedida.
 */
export async function exigirVinculo(req: RequestMovil, res: Response, next: NextFunction): Promise<void> {
  try {
    const vinculos = await vinculosPorEscolares(req.usuario!.userId);
    if (vinculos.length === 0) {
      res.status(403).json({ message: 'Este celular no está vinculado', codigo: 'sin_vincular' });
      return;
    }
    // Todos los vínculos de una cuenta comparten celular principal.
    if (vinculos[0].dispositivoId !== req.dispositivoId) {
      const secundario = await secundarioPorDispositivo(req.dispositivoId!);
      if (!secundario || secundario.escolaresUserId !== req.usuario!.userId) {
        res.status(403).json({
          message: `Tu cuenta está vinculada en otro celular (${vinculos[0].dispositivoNombre})`,
          codigo: 'otro_dispositivo',
        });
        return;
      }
      req.secundario = secundario;
      tocarSecundario(secundario);
    }

    const pedida = tiendaPedida(req);
    const vinculo = pedida ? vinculos.find((v) => v.tiendaId === pedida) : vinculos[0];
    if (!vinculo) {
      res.status(403).json({ message: 'No estás vinculado en esa tienda', codigo: 'sin_tienda' });
      return;
    }
    req.vinculos = vinculos;
    req.usuarios = vinculos.map((v) => v._id);
    req.vinculo = vinculo;
    next();
  } catch (error) {
    next(error);
  }
}
