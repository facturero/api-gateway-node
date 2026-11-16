import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Server as SocketServer } from 'socket.io';
import { PresenceRegistry, registerChatSocket } from './chat-socket';
import { ChatMembersCache } from './chat-members';

const ORG = 'org-1';
const CONV = '11111111-1111-4111-8111-111111111111';

/** `io` falso: guarda lo emitido por sala y deja conectar sockets a mano. */
function fakeIo() {
  const emitted: Array<{ room: string; event: string; data: unknown }> = [];
  let onConnection: ((s: unknown) => void) | null = null;
  const io = {
    on: (_: string, cb: (s: unknown) => void) => (onConnection = cb),
    to: (room: string) => ({ emit: (event: string, data: unknown) => emitted.push({ room, event, data }) }),
  } as unknown as SocketServer;
  let n = 0;
  function connect(userId: string, orgId = ORG) {
    const handlers = new Map<string, (...a: unknown[]) => void>();
    const socket = { id: `s${++n}`, data: { organizationId: orgId, subjectId: userId }, on: (e: string, h: (...a: unknown[]) => void) => handlers.set(e, h) };
    onConnection!(socket);
    const send = (e: string, payload?: unknown) => {
      let res: unknown;
      handlers.get(e)!(payload, (r: unknown) => (res = r));
      return res as { ok: boolean; data?: Record<string, string> };
    };
    return { send, disconnect: () => handlers.get('disconnect')!() };
  }
  return { io, emitted, connect };
}

describe('chat-socket: presencia', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('entra al anunciarse (no al conectar: la caja POS también conecta) y avisa solo en las transiciones', () => {
    const presence = new PresenceRegistry();
    const { io, emitted, connect } = fakeIo();
    registerChatSocket(io, { presence });

    const tab1 = connect('Ana');
    expect(presence.state(ORG, 'ana')).toBe('offline');
    tab1.send('chat:activity', { state: 'active' });
    const tab2 = connect('ana');
    tab2.send('chat:activity', { state: 'active' });
    expect(emitted).toEqual([{ room: `catalog:${ORG}`, event: 'chat.presence', data: { userId: 'ana', state: 'online' } }]);

    // Ausente solo cuando TODAS sus pestañas lo están.
    tab1.send('chat:activity', { state: 'away' });
    expect(presence.state(ORG, 'ana')).toBe('online');
    tab2.send('chat:activity', { state: 'away' });
    expect(presence.state(ORG, 'ana')).toBe('away');
    expect(emitted.at(-1)?.data).toEqual({ userId: 'ana', state: 'away' });
    expect(presence.isActive(ORG, 'ana')).toBe(false);
  });

  it('desconectarse emite offline tras la gracia; una recarga a tiempo no parpadea', () => {
    const presence = new PresenceRegistry();
    const { io, emitted, connect } = fakeIo();
    registerChatSocket(io, { presence, offlineGraceMs: 30_000 });

    const tab = connect('ana');
    tab.send('chat:activity', { state: 'active' });
    tab.disconnect();
    vi.advanceTimersByTime(10_000);
    const again = connect('ana');
    again.send('chat:activity', { state: 'active' });
    vi.advanceTimersByTime(30_000);
    expect(emitted.filter((e) => (e.data as { state: string }).state === 'offline')).toHaveLength(0);

    again.disconnect();
    vi.advanceTimersByTime(30_000);
    expect(emitted.at(-1)?.data).toEqual({ userId: 'ana', state: 'offline' });
  });

  it('chat:presence responde solo con la organización de quien pregunta', () => {
    const presence = new PresenceRegistry();
    const { io, connect } = fakeIo();
    registerChatSocket(io, { presence });
    connect('ana').send('chat:activity', { state: 'active' });
    connect('eva', 'org-2').send('chat:activity', { state: 'active' });

    const res = connect('luis').send('chat:presence', { userIds: ['ana', 'eva', 'nadie'] });
    expect(res).toEqual({ ok: true, data: { ana: 'online', eva: 'offline', nadie: 'offline' } });
    expect(connect('luis').send('chat:presence', { userIds: 'x' }).ok).toBe(false);
  });
});

describe('chat-socket: escribiendo…', () => {
  const flush = () => new Promise((r) => setTimeout(r, 0));

  it('solo un miembro puede avisar, y solo lo reciben los demás miembros; como mucho uno cada 3 s', async () => {
    let t = 0;
    const source = { memberIds: vi.fn(async () => ['ana', 'luis', 'eva']) };
    const members = new ChatMembersCache(source);
    const { io, emitted, connect } = fakeIo();
    registerChatSocket(io, { presence: new PresenceRegistry(), members, now: () => t });

    const ana = connect('ana');
    ana.send('chat:typing', { conversationId: CONV });
    await flush();
    expect(emitted.map((e) => e.room).sort()).toEqual(['user:eva', 'user:luis']);
    expect(emitted[0].data).toEqual({ conversationId: CONV, threadRootId: null, userId: 'ana' });

    t = 1_000;
    ana.send('chat:typing', { conversationId: CONV });
    await flush();
    expect(emitted).toHaveLength(2);
    t = 3_500;
    ana.send('chat:typing', { conversationId: CONV });
    await flush();
    expect(emitted).toHaveLength(4);
    expect(source.memberIds).toHaveBeenCalledTimes(1); // caché

    connect('intruso').send('chat:typing', { conversationId: CONV });
    await flush();
    expect(emitted).toHaveLength(4);
  });

  it('la caché se invalida (chat.member.*) y no guarda un fallo de chat-service', async () => {
    let fail = true;
    const source = { memberIds: vi.fn(async () => (fail ? null : ['ana'])) };
    const cache = new ChatMembersCache(source);
    expect(await cache.members(ORG, CONV)).toBeNull();
    fail = false;
    expect([...(await cache.members(ORG, CONV))!]).toEqual(['ana']);
    await cache.members(ORG, CONV);
    expect(source.memberIds).toHaveBeenCalledTimes(2);
    cache.invalidate(ORG, CONV);
    await cache.members(ORG, CONV);
    expect(source.memberIds).toHaveBeenCalledTimes(3);
  });
});
