import { emitirADispositivo } from './autorizaciones-socket.service';
import {
  cerrarVista,
  crearVista,
  estadoVista,
  frameDeCelular,
  frameDePc,
  frameVista,
  rechazarDesdeCelular,
  vistasDePc,
} from './autorizaciones-pantallas.service';

jest.mock('./autorizaciones-socket.service', () => ({ emitirADispositivo: jest.fn() }));
// Sin base de datos ni secretos: el servicio solo usa la clase de error de vínculos.
jest.mock('../config/database', () => ({ database: { getCollection: jest.fn() } }));
jest.mock('./push.service', () => ({ enviarPushATokens: jest.fn(), enviarDatosATokens: jest.fn() }));

const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
const admin = { _id: 'centro:1', sellhubNombre: 'Admin', tiendaId: 'centro' };

describe('ver pantalla de una PC', () => {
  it('la PC de la sesión ve el pedido, sube fotos y quien mira las recibe', () => {
    const { id } = crearVista(admin, { tipo: 'pc', objetivo: 'sesion-1', objetivoNombre: 'Caja 1' }, 'Centro');
    expect(vistasDePc('centro', 'sesion-1')).toEqual([{ id, espectadorNombre: 'Admin' }]);
    expect(vistasDePc('centro', 'otra-sesion')).toEqual([]);

    expect(frameDePc('centro', id, jpeg)).toEqual({ seguir: true });
    expect(estadoVista(['centro:1'], id)).toMatchObject({ estado: 'activa', frameNum: 1 });
    expect(frameVista(['centro:1'], id)).toEqual(jpeg);

    cerrarVista(['centro:1'], id);
    expect(frameDePc('centro', id, jpeg)).toEqual({ seguir: false });
    expect(vistasDePc('centro', 'sesion-1')).toEqual([]);
  });

  it('otra tienda no puede ver ni alimentar esa vista', () => {
    const { id } = crearVista(admin, { tipo: 'pc', objetivo: 'sesion-2', objetivoNombre: 'Caja 2' }, 'Centro');
    expect(vistasDePc('norte', 'sesion-2')).toEqual([]);
    expect(frameDePc('norte', id, jpeg)).toEqual({ seguir: false });
    expect(() => estadoVista(['norte:1'], id)).toThrow();
  });

  it('una vista nueva del mismo admin cierra la anterior', () => {
    const primera = crearVista(admin, { tipo: 'pc', objetivo: 'sesion-3', objetivoNombre: 'A' }, 'Centro');
    crearVista(admin, { tipo: 'pc', objetivo: 'sesion-4', objetivoNombre: 'B' }, 'Centro');
    expect(estadoVista(['centro:1'], primera.id).estado).toBe('terminada');
  });
});

describe('ver pantalla de un celular', () => {
  it('se le pide por socket y solo ese celular puede subir o rechazar', () => {
    const { id } = crearVista(
      admin,
      { tipo: 'celular', objetivo: 'disp-9', objetivoNombre: 'Ana · Samsung', objetivoCuenta: 'cuenta-9' },
      'Centro',
    );
    expect(emitirADispositivo).toHaveBeenCalledWith('cuenta-9', 'disp-9', 'pantalla:pedida', expect.objectContaining({ id }));

    expect(frameDeCelular(id, 'otro-celular', jpeg)).toEqual({ seguir: false });
    rechazarDesdeCelular(id, 'otro-celular');
    expect(estadoVista(['centro:1'], id).estado).toBe('esperando');

    rechazarDesdeCelular(id, 'disp-9');
    expect(estadoVista(['centro:1'], id)).toMatchObject({ estado: 'rechazada', mensaje: 'No aceptó compartir su pantalla' });
    expect(emitirADispositivo).toHaveBeenCalledWith('cuenta-9', 'disp-9', 'pantalla:terminada', { id });
  });
});
