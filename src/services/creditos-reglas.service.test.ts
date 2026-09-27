import {
  calcularIva,
  desglosarIva,
  diasAtrasoDe,
  limitePorNivel,
  limiteTotal,
  moraDeProximaCuota,
  nivelPorCuotasPagadas,
  nombreNivel,
  penalizacionAcumulada,
  simularCredito,
  totalConMora,
} from './creditos-reglas.service';
import { CreditoReglas, CreditoSolicitud } from '../models';

const REGLAS: CreditoReglas = {
  id: 'reglas',
  nivelBase: 100,
  factorNivel: 1.5,
  nivelMaximo: 5,
  cuotas: 3,
  diasEntreCuotas: 15,
  tasaQuincenal: 0.02,
  ivaTasa: 0.16,
  montoMinimo: 50,
  categorias: [],
  nombresNiveles: ['Bronce', 'Plata', 'Oro', 'Platino', 'Diamante'],
  cuotasParaNivel: [5, 10, 15, 20],
  updatedAt: new Date(),
};

const DIA_MS = 24 * 60 * 60 * 1000;

describe('limitePorNivel', () => {
  it('nivel 1 es el límite base', () => {
    expect(limitePorNivel(REGLAS, 1)).toBe(100);
  });

  it('cada nivel multiplica por factorNivel', () => {
    expect(limitePorNivel(REGLAS, 2)).toBe(150);
    expect(limitePorNivel(REGLAS, 3)).toBe(225);
  });

  it('nunca baja del nivel 1 aunque llegue algo menor', () => {
    expect(limitePorNivel(REGLAS, 0)).toBe(100);
    expect(limitePorNivel(REGLAS, -5)).toBe(100);
  });

  it('se topa en nivelMaximo aunque pidan uno mayor', () => {
    expect(limitePorNivel(REGLAS, 99)).toBe(limitePorNivel(REGLAS, REGLAS.nivelMaximo));
  });
});

describe('limiteTotal', () => {
  it('sin extensión, es el límite del nivel', () => {
    expect(limiteTotal(REGLAS, { nivel: 1 })).toBe(100);
  });

  it('suma la extensión de crédito otorgada a mano', () => {
    expect(limiteTotal(REGLAS, { nivel: 1, extensionCredito: 50 })).toBe(150);
  });
});

describe('nombreNivel', () => {
  it('usa el nombre configurado', () => {
    expect(nombreNivel(REGLAS, 1)).toBe('Bronce');
    expect(nombreNivel(REGLAS, 5)).toBe('Diamante');
  });

  it('cae a "Nivel N" si no hay nombres configurados', () => {
    const sinNombres: CreditoReglas = { ...REGLAS, nombresNiveles: undefined };
    expect(nombreNivel(sinNombres, 2)).toBe('Nivel 2');
  });
});

describe('nivelPorCuotasPagadas', () => {
  it('arranca en nivel 1 sin cuotas pagadas', () => {
    expect(nivelPorCuotasPagadas(REGLAS, 0)).toBe(1);
  });

  it('no sube de nivel hasta completar las cuotas requeridas', () => {
    expect(nivelPorCuotasPagadas(REGLAS, 4)).toBe(1);
  });

  it('sube de nivel justo al alcanzar el umbral', () => {
    expect(nivelPorCuotasPagadas(REGLAS, 5)).toBe(2);
  });

  it('va acumulando los umbrales de cada nivel', () => {
    expect(nivelPorCuotasPagadas(REGLAS, 15)).toBe(3);
    expect(nivelPorCuotasPagadas(REGLAS, 49)).toBe(4);
  });

  it('se topa en nivelMaximo aunque sobren cuotas', () => {
    expect(nivelPorCuotasPagadas(REGLAS, 50)).toBe(5);
    expect(nivelPorCuotasPagadas(REGLAS, 1000)).toBe(5);
  });
});

describe('calcularIva', () => {
  it('aplica la tasa de IVA sobre el subtotal', () => {
    expect(calcularIva(REGLAS, 100)).toBe(16);
  });
});

describe('desglosarIva', () => {
  it('separa un monto con IVA incluido en subtotal + IVA', () => {
    // 116 = 100 de subtotal + 16 de IVA (16%), sin ambigüedad de redondeo.
    expect(desglosarIva(REGLAS, 116)).toEqual({ subtotal: 100, iva: 16 });
  });

  it('subtotal + iva vuelve a dar el monto original', () => {
    const { subtotal, iva } = desglosarIva(REGLAS, 50);
    expect(Math.round((subtotal + iva) * 100) / 100).toBe(50);
  });
});

describe('simularCredito', () => {
  it('aplica el interés simple por cuota sobre el monto', () => {
    // 100 * (1 + 0.02*3) = 106; 106 / 3 cuotas = 35.33
    expect(simularCredito(REGLAS, 100)).toEqual({ total: 106, cuotaMonto: 35.33 });
  });
});

// cuotaMonto consistente con factura.total, como lo calcula aceptarSolicitud de verdad:
// (factura.total - pagoInicial) / cuotas = (116 - 16) / 3 = 33.33.
function solicitudBase(overrides: Partial<CreditoSolicitud> = {}): CreditoSolicitud {
  return {
    id: '1',
    usuarioId: 'u1',
    monto: 100,
    cuotas: 3,
    frecuencia: 'quincenal',
    cuotaMonto: 33.33,
    total: 116,
    proposito: 'Compra de prueba',
    status: 'activo',
    cuotasPagadas: 0,
    createdAt: new Date(),
    factura: { numero: 'F-000001', emitidaEn: new Date(), subtotal: 100, iva: 16, total: 116 },
    ...overrides,
  };
}

describe('diasAtrasoDe', () => {
  it('no está atrasado si no está activo', () => {
    expect(diasAtrasoDe(solicitudBase({ status: 'pendiente_aceptacion' }), REGLAS)).toBe(0);
  });

  it('no está atrasado si la primera cuota todavía no vence', () => {
    const activadoEn = new Date(Date.now() - 5 * DIA_MS); // faltan 10 días para la cuota 1
    expect(diasAtrasoDe(solicitudBase({ activadoEn, pagoInicial: 16, montoPagado: 16 }), REGLAS)).toBe(0);
  });

  it('cuenta los días desde el vencimiento de la primera cuota impaga', () => {
    const activadoEn = new Date(Date.now() - 20 * DIA_MS); // la cuota 1 venció hace 5 días
    const dias = diasAtrasoDe(solicitudBase({ activadoEn, pagoInicial: 16, montoPagado: 16 }), REGLAS);
    expect(dias).toBe(5);
  });

  it('no está atrasado si ya pagó al día con esa cuota', () => {
    const activadoEn = new Date(Date.now() - 20 * DIA_MS);
    const dias = diasAtrasoDe(solicitudBase({ activadoEn, pagoInicial: 16, montoPagado: 16 + 33.33 }), REGLAS);
    expect(dias).toBe(0);
  });

  it('no está atrasado si ya se pagó todo el crédito', () => {
    const activadoEn = new Date(Date.now() - 100 * DIA_MS);
    const dias = diasAtrasoDe(solicitudBase({ activadoEn, pagoInicial: 16, montoPagado: 116 }), REGLAS);
    expect(dias).toBe(0);
  });
});

describe('penalizacionAcumulada', () => {
  it('sin atraso no hay mora', () => {
    const activadoEn = new Date(Date.now() - 5 * DIA_MS);
    expect(penalizacionAcumulada(solicitudBase({ activadoEn, pagoInicial: 16, montoPagado: 16 }), REGLAS)).toBe(0);
  });

  it('antes de completar 3 días de atraso todavía no cobra mora', () => {
    const activadoEn = new Date(Date.now() - 17 * DIA_MS); // cuota 1 vencida hace 2 días
    expect(penalizacionAcumulada(solicitudBase({ activadoEn, pagoInicial: 16, montoPagado: 16 }), REGLAS)).toBe(0);
  });

  it('$2 por cada 3 días completos de atraso de la cuota impaga', () => {
    const activadoEn = new Date(Date.now() - 24 * DIA_MS); // cuota 1 vencida hace 9 días
    expect(penalizacionAcumulada(solicitudBase({ activadoEn, pagoInicial: 16, montoPagado: 16 }), REGLAS)).toBe(6);
  });

  it('suma la mora de cada cuota atrasada si hay más de una sin pagar', () => {
    const activadoEn = new Date(Date.now() - 39 * DIA_MS);
    // cuota 1 (vence a los 15 días) atrasada 24 días -> $16; cuota 2 (vence a los 30) atrasada 9 -> $6;
    // cuota 3 (vence a los 45) todavía no vence -> $0.
    const dias = penalizacionAcumulada(solicitudBase({ activadoEn, pagoInicial: 16, montoPagado: 16 }), REGLAS);
    expect(dias).toBe(22);
  });

  it('no hay mora si ya se pagó todo el crédito', () => {
    const activadoEn = new Date(Date.now() - 100 * DIA_MS);
    expect(penalizacionAcumulada(solicitudBase({ activadoEn, pagoInicial: 16, montoPagado: 116 }), REGLAS)).toBe(0);
  });
});

describe('totalConMora', () => {
  it('es la factura sola si no hay atraso', () => {
    const activadoEn = new Date(Date.now() - 5 * DIA_MS);
    expect(totalConMora(solicitudBase({ activadoEn, pagoInicial: 16, montoPagado: 16 }), REGLAS)).toBe(116);
  });

  it('suma la mora acumulada a la factura', () => {
    const activadoEn = new Date(Date.now() - 20 * DIA_MS); // cuota 1 atrasada 5 días -> $2 de mora
    expect(totalConMora(solicitudBase({ activadoEn, pagoInicial: 16, montoPagado: 16 }), REGLAS)).toBe(118);
  });
});

describe('moraDeProximaCuota', () => {
  it('usa cuotasPagadas para saber cuál es la próxima cuota, no montoPagado', () => {
    const activadoEn = new Date(Date.now() - 20 * DIA_MS); // cuota 1 vencida hace 5 días
    const mora = moraDeProximaCuota(solicitudBase({ activadoEn, cuotasPagadas: 0 }), REGLAS);
    expect(mora).toBe(2);
  });

  it('es 0 si ya se pagaron todas las cuotas', () => {
    const activadoEn = new Date(Date.now() - 100 * DIA_MS);
    const mora = moraDeProximaCuota(solicitudBase({ activadoEn, cuotasPagadas: 3 }), REGLAS);
    expect(mora).toBe(0);
  });

  it('es 0 si el crédito no está activo', () => {
    const mora = moraDeProximaCuota(solicitudBase({ status: 'pagado' }), REGLAS);
    expect(mora).toBe(0);
  });
});
