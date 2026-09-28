/**
 * A qué salas hay que emitir un `organization.pos_theme.changed`.
 *
 * Vive aparte de `hub.ts` y es una función pura a propósito: decide a dónde va
 * el aviso sin tocar sockets, sin RabbitMQ y sin `io`, que es la forma de que
 * esto se pueda probar. El enrutado es justo lo que se equivoca en silencio —
 * emitir a una sala vacía no da ningún error, el aviso se pierde y nadie se
 * entera hasta que un cliente dice que "el tema no se aplica".
 */

/** Prefijos de sala. Duplicados de `hub.ts` a propósito: este módulo no importa
 * el hub para no arrastrar `socket.io` a los tests. */
export const ROOM_PREFIX = 'catalog:';
export const DEVICE_ROOM_PREFIX = 'device:';

export type PosThemeChangedPayload = {
  organizationId: string;
  /** `null` cuando lo que cambió fue una asignación: se quitó el override. */
  themeId: string | null;
  affectedEmissionPointIds: string[] | 'all';
  /** Lo que el gateway puede enrutar: la sala dirigida es la del dispositivo. */
  affectedDeviceIds: string[];
};

export type PosThemeRouting = {
  /** Salas a las que emitir `pos_theme.changed`. */
  rooms: string[];
  /** La organización del evento, ya validada como string. */
  organizationId: string;
  /** `'org'` = cambió el predeterminado y cada caja decide; `'devices'` = solo
   *  las cajas de la lista. Sirve para el log y para que el test afirme qué
   *  modo se usó. */
  mode: 'org' | 'devices';
};

/**
 * Lee `affectedDeviceIds` de un evento que viene de la cola. Todo lo que llega
 * de RabbitMQ lo produce otro proceso y puede no ser lo que creemos, así que se
 * comprueba en vez de castear: un id no-string haría que `io.to()` se fuera a
 * una sala imposible y el aviso se perdería sin error.
 */
export function readDeviceIds(valor: unknown): string[] {
  if (!Array.isArray(valor)) return [];
  return valor.filter((id): id is string => typeof id === 'string' && id.length > 0);
}

/**
 * Devuelve las salas a las que hay que emitir, o `null` si el evento no es
 * utilizable (sin `organizationId`; el mensaje se descarta con `nack`).
 */
export function posThemeRooms(
  payload: PosThemeChangedPayload | Record<string, unknown>,
): PosThemeRouting | null {
  const organizationId = payload.organizationId;
  if (typeof organizationId !== 'string' || organizationId.length === 0) return null;

  if (payload.affectedEmissionPointIds === 'all') {
    // Cambió el tema predeterminado: le toca a toda caja sin override propio.
    // Cada una decide comparando su punto contra el tema que ya tiene resuelto.
    return {
      rooms: [`${ROOM_PREFIX}${organizationId}`],
      organizationId,
      mode: 'org',
    };
  }

  const deviceIds = readDeviceIds(payload.affectedDeviceIds);
  return {
    rooms: deviceIds.map((d) => `${DEVICE_ROOM_PREFIX}${d}`),
    organizationId,
    mode: 'devices',
  };
}

/**
 * El aviso que viaja al socket. Deliberadamente **no** incluye el config: la
 * caja lo vuelve a pedir por REST con su `If-None-Match` y así sale un 304 sin
 * bytes. Mandarlo por el socket obligaría al gateway a conocer el formato del
 * tema, que es propiedad de organization-service, y a duplicar un kilobyte por
 * caja en cada cambio.
 */
export function posThemeSocketPayload(
  payload: PosThemeChangedPayload | Record<string, unknown>,
  organizationId: string,
): { event: string; organizationId: string; themeId: string | null } {
  return {
    event: 'organization.pos_theme.changed',
    organizationId,
    themeId: typeof payload.themeId === 'string' ? payload.themeId : null,
  };
}
