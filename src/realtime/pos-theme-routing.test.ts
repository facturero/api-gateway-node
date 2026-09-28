import { describe, it, expect } from 'vitest';
import {
  posThemeRooms,
  posThemeSocketPayload,
  readDeviceIds,
} from './pos-theme-routing';

const ORG = '3f1c8a20-0000-4000-8000-000000000001';

describe('readDeviceIds', () => {
  it('acepta una lista de strings', () => {
    expect(readDeviceIds(['a', 'b'])).toEqual(['a', 'b']);
  });

  it('descarta lo que no es un id usable, en vez de dejarlo pasar', () => {
    // El payload viene de otro proceso. Un id no-string haría que `io.to()` fuera
    // a una sala imposible y el aviso se perdería sin ningún error visible.
    expect(readDeviceIds(['a', 42, null, undefined, '', {}, 'b'])).toEqual(['a', 'b']);
  });

  it('devuelve vacío si no es una lista', () => {
    expect(readDeviceIds(undefined)).toEqual([]);
    expect(readDeviceIds(null)).toEqual([]);
    expect(readDeviceIds('all')).toEqual([]);
    expect(readDeviceIds({})).toEqual([]);
  });
});

describe('posThemeRooms · predeterminado de la organización', () => {
  it('con "all" va a la sala de la organización, una sola', () => {
    const r = posThemeRooms({
      organizationId: ORG,
      themeId: 'theme-1',
      affectedEmissionPointIds: 'all',
      affectedDeviceIds: [],
    });
    expect(r).toEqual({ rooms: [`catalog:${ORG}`], organizationId: ORG, mode: 'org' });
  });

  it('con "all" da igual que vengan deviceIds: manda la sala de la org', () => {
    // El publicador los manda vacíos, pero si algún día se rellenan no
    // queremos que la caja se entere dos veces.
    const r = posThemeRooms({
      organizationId: ORG,
      themeId: 'theme-1',
      affectedEmissionPointIds: 'all',
      affectedDeviceIds: ['dev-1'],
    });
    expect(r?.rooms).toEqual([`catalog:${ORG}`]);
  });

  it('la sala de la org incluye a los navegadores del CRM, no solo a los POS', () => {
    // Es lo que hace que el editor del CRM se refresque solo cuando cambia el
    // predeterminado, sin que haya que ir a la lista a recargar a mano.
    expect(posThemeRooms({
      organizationId: ORG,
      themeId: 't',
      affectedEmissionPointIds: 'all',
      affectedDeviceIds: [],
    })?.rooms).toEqual([`catalog:${ORG}`]);
  });
});

describe('posThemeRooms · tema propio de una caja', () => {
  it('con lista de devices va a esas salas, no a la de la organización', () => {
    const r = posThemeRooms({
      organizationId: ORG,
      themeId: 'theme-2',
      affectedEmissionPointIds: ['ep-1', 'ep-2'],
      affectedDeviceIds: ['dev-1', 'dev-2'],
    });
    // Punto clave: si aquí se colara la sala de la org, cada cambio de un tema
    // propio haría que todas las cajas de la tienda volcaran su tema, que es
    // justo lo que se pidió evitar.
    expect(r).toEqual({
      rooms: [`device:dev-1`, `device:dev-2`],
      organizationId: ORG,
      mode: 'devices',
    });
    expect(r?.rooms).not.toContain(`catalog:${ORG}`);
  });

  it('una caja no emparejada no genera ninguna sala, y eso no es un error', () => {
    const r = posThemeRooms({
      organizationId: ORG,
      themeId: 'theme-2',
      affectedEmissionPointIds: ['ep-1'],
      affectedDeviceIds: [],
    });
    expect(r?.rooms).toEqual([]);
    expect(r?.mode).toBe('devices');
  });

  it('descarta deviceIds malformados en vez de crear salas imposibles', () => {
    const r = posThemeRooms({
      organizationId: ORG,
      themeId: 'theme-2',
      affectedEmissionPointIds: ['ep-1'],
      affectedDeviceIds: ['dev-1', 99, null],
    });
    expect(r?.rooms).toEqual(['device:dev-1']);
  });
});

describe('posThemeRooms · evento inservible', () => {
  it('sin organizationId devuelve null para que el mensaje se descarte', () => {
    expect(posThemeRooms({ themeId: 't', affectedEmissionPointIds: 'all' })).toBeNull();
    expect(posThemeRooms({ organizationId: '', affectedEmissionPointIds: 'all' })).toBeNull();
    expect(posThemeRooms({ organizationId: 123, affectedEmissionPointIds: 'all' })).toBeNull();
  });
});

describe('posThemeSocketPayload', () => {
  it('lleva el evento, la org y el tema, y NADA más', () => {
    const aviso = posThemeSocketPayload(
      {
        organizationId: ORG,
        themeId: 'theme-2',
        affectedEmissionPointIds: ['ep-1'],
        affectedDeviceIds: ['dev-1'],
        // Aunque viniera, el config no se reenvía:
        config: { colors: { light: { primary: '#2563eb' } } },
      },
      ORG,
    );
    expect(aviso).toEqual({
      event: 'organization.pos_theme.changed',
      organizationId: ORG,
      themeId: 'theme-2',
    });
    // La caja vuelve a pedir el config por REST con su ETag; mandarlo aquí
    // obligaría al gateway a conocer el formato del tema y a gastar un KB por
    // caja en cada cambio.
    expect(Object.keys(aviso)).not.toContain('config');
  });

  it('themeId null cuando lo que cambió fue quitar un override', () => {
    const aviso = posThemeSocketPayload(
      { organizationId: ORG, themeId: null, affectedEmissionPointIds: ['ep-1'] },
      ORG,
    );
    expect(aviso.themeId).toBeNull();
  });

  it('un themeId que no es string sale null, no undefined', () => {
    // `undefined` desaparecería al serializar y el cliente no distinguiría "no
    // hay tema" de "se quitó el override".
    const aviso = posThemeSocketPayload({ organizationId: ORG }, ORG);
    expect(aviso.themeId).toBeNull();
    expect(JSON.stringify(aviso)).toContain('"themeId":null');
  });
});
