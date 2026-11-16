import { Response } from 'express';
import { exigirVinculo, RequestMovil } from './autorizaciones.middleware';
import { secundarioPorDispositivo, vinculosPorEscolares } from '../services/autorizaciones-vinculos.service';
import { idSellhub, tiendaDeUid, uid } from '../services/autorizaciones-tiendas.service';

// Sin base de datos ni secretos: solo la lógica de qué tienda y qué celular.
jest.mock('../config/jwt', () => ({ jwtConfig: { verifyAccessToken: jest.fn() } }));
jest.mock('../config/database', () => ({ database: { getCollection: jest.fn() } }));
jest.mock('../services/autorizaciones-vinculos.service', () => ({
  vinculosPorEscolares: jest.fn(),
  secundarioPorDispositivo: jest.fn(),
}));
jest.mock('../services/autorizaciones-dispositivos.service', () => ({ tocarSecundario: jest.fn() }));

const mockVinculos = vinculosPorEscolares as jest.Mock;
const mockSecundario = secundarioPorDispositivo as jest.Mock;

/** Vínculo de la cuenta "cuenta-1" en una tienda, con su celular principal "cel-principal". */
const vinculo = (tiendaId: string, usuarioId: string) => ({
  _id: uid(tiendaId, usuarioId),
  tiendaId,
  sellhubUsuarioId: usuarioId,
  sellhubNombre: `Usuario ${usuarioId}`,
  escolaresUserId: 'cuenta-1',
  escolaresNombre: 'Cuenta 1',
  dispositivoId: 'cel-principal',
  dispositivoNombre: 'Principal',
  pushTokens: [],
  vinculadoEn: new Date(),
});

function llamar(opciones: { dispositivoId?: string; tienda?: string } = {}) {
  const req = {
    usuario: { userId: 'cuenta-1' },
    dispositivoId: opciones.dispositivoId ?? 'cel-principal',
    query: opciones.tienda ? { tienda: opciones.tienda } : {},
    header: () => undefined,
  } as unknown as RequestMovil;
  const res = { status: jest.fn().mockReturnThis(), json: jest.fn() } as unknown as Response & { status: jest.Mock; json: jest.Mock };
  const next = jest.fn();
  return { req, res, next, listo: exigirVinculo(req, res, next) };
}

describe('ids internos multitienda', () => {
  it('separan tienda y usuario aunque el usuario se repita entre tiendas', () => {
    expect(uid('centro', 5)).toBe('centro:5');
    expect(uid('norte', 5)).not.toBe(uid('centro', 5));
    expect(idSellhub('centro:5')).toBe('5');
    expect(tiendaDeUid('centro:5')).toBe('centro');
  });
});

describe('exigirVinculo', () => {
  it('rechaza una cuenta sin vínculos', async () => {
    mockVinculos.mockResolvedValue([]);
    const { res, next, listo } = llamar();
    await listo;
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json.mock.calls[0][0].codigo).toBe('sin_vincular');
    expect(next).not.toHaveBeenCalled();
  });

  it('desde el principal, sin tienda pedida usa la primera y deja todos los usuarios', async () => {
    mockVinculos.mockResolvedValue([vinculo('centro', '5'), vinculo('norte', '9')]);
    const { req, next, listo } = llamar();
    await listo;
    expect(next).toHaveBeenCalled();
    expect(req.vinculo!.tiendaId).toBe('centro');
    expect(req.usuarios).toEqual(['centro:5', 'norte:9']);
  });

  it('usa la tienda pedida', async () => {
    mockVinculos.mockResolvedValue([vinculo('centro', '5'), vinculo('norte', '9')]);
    const { req, next, listo } = llamar({ tienda: 'norte' });
    await listo;
    expect(next).toHaveBeenCalled();
    expect(req.vinculo!._id).toBe('norte:9');
  });

  it('rechaza una tienda donde la cuenta no está vinculada', async () => {
    mockVinculos.mockResolvedValue([vinculo('centro', '5')]);
    const { res, next, listo } = llamar({ tienda: 'otra' });
    await listo;
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json.mock.calls[0][0].codigo).toBe('sin_tienda');
    expect(next).not.toHaveBeenCalled();
  });

  it('acepta un secundario de la misma cuenta (ve todas sus tiendas)', async () => {
    mockVinculos.mockResolvedValue([vinculo('centro', '5'), vinculo('norte', '9')]);
    mockSecundario.mockResolvedValue({ _id: 'cel-2', id: 'x', escolaresUserId: 'cuenta-1' });
    const { req, next, listo } = llamar({ dispositivoId: 'cel-2' });
    await listo;
    expect(next).toHaveBeenCalled();
    expect(req.secundario).toBeDefined();
    expect(req.usuarios).toHaveLength(2);
  });

  it('rechaza un celular que no es de la cuenta', async () => {
    mockVinculos.mockResolvedValue([vinculo('centro', '5')]);
    mockSecundario.mockResolvedValue({ _id: 'cel-ajeno', id: 'y', escolaresUserId: 'otra-cuenta' });
    const { res, next, listo } = llamar({ dispositivoId: 'cel-ajeno' });
    await listo;
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json.mock.calls[0][0].codigo).toBe('otro_dispositivo');
    expect(next).not.toHaveBeenCalled();
  });
});
