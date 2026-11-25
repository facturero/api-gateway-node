import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Server as SocketServer } from 'socket.io';
import { registerAssistantSocket } from './assistant-socket';
import type { Authenticator } from '../core/types';

/**
 * El token del handshake caduca a los 15 minutos y el asistente seguía usándolo («exp claim timestamp check failed»,
 * producción 2026-11-25). Ahora cada mensaje trae el token vigente y aquí se valida.
 */
const ORG = 'org-1';
const USER = 'user-1';

/** Tokens de mentira: «ok:<sub>:<org>» es válido, cualquier otro está caducado. */
const authenticator: Authenticator = {
  async authenticate(getHeader) {
    const token = getHeader('authorization')?.replace(/^Bearer /, '') ?? '';
    const [kind, sub, org] = token.split(':');
    return kind === 'ok' ? { authenticated: true, claims: { sub, org_id: org } } : { authenticated: false, error: 'exp claim timestamp check failed' };
  },
};

function setup(handshakeToken: string, withAuthenticator = true) {
  let onConnection: ((s: unknown) => void) | null = null;
  const io = { on: (_: string, cb: (s: unknown) => void) => (onConnection = cb) } as unknown as SocketServer;
  registerAssistantSocket(io, { assistantServiceUrl: 'http://assistant:3014', authenticator: withAuthenticator ? authenticator : undefined });
  const handlers = new Map<string, (...a: unknown[]) => void>();
  const socket = {
    connected: true,
    data: { organizationId: ORG, subjectId: USER, bearerToken: handshakeToken, locale: 'es' },
    on: (e: string, h: (...a: unknown[]) => void) => handlers.set(e, h),
    emit: vi.fn(),
  };
  onConnection!(socket);
  const send = (event: string, payload: unknown) =>
    new Promise<{ ok: boolean; code?: string; message?: string; data?: unknown }>((resolve) => handlers.get(event)!(payload, resolve));
  return { socket, send };
}

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockResolvedValue(new Response(JSON.stringify({ reply: 'hola' }), { status: 200 }));
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

const sentAuthorization = () => (fetchMock.mock.calls[0]![1] as { headers: Record<string, string> }).headers.Authorization;

describe('assistant-socket: token por mensaje', () => {
  it('usa el token que trae el mensaje y lo guarda para los siguientes', async () => {
    const { socket, send } = setup('caducado');
    const res = await send('assistant:send', { text: 'hola', conversationId: null, token: `ok:${USER}:${ORG}` });
    expect(res).toMatchObject({ ok: true });
    expect(sentAuthorization()).toBe(`Bearer ok:${USER}:${ORG}`);
    expect(socket.data.bearerToken).toBe(`ok:${USER}:${ORG}`);
  });

  it('con el token del handshake caducado y sin token en el mensaje, avisa en vez de llamar con él', async () => {
    const { send } = setup('caducado');
    const res = await send('assistant:send', { text: 'hola', conversationId: null });
    expect(res).toMatchObject({ ok: false, code: 'TOKEN_EXPIRED' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('un token válido de otra persona u otra organización no se cuela en este socket', async () => {
    const { socket, send } = setup(`ok:${USER}:${ORG}`);
    expect(await send('assistant:send', { text: 'x', token: `ok:otra:${ORG}` })).toMatchObject({ ok: false, code: 'TOKEN_MISMATCH' });
    expect(await send('assistant:decide', { actionId: 'a1', approve: true, token: `ok:${USER}:otra-org` })).toMatchObject({
      ok: false,
      code: 'TOKEN_MISMATCH',
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(socket.data.bearerToken).toBe(`ok:${USER}:${ORG}`);
  });

  it('decidir también usa el token del mensaje', async () => {
    const { send } = setup('caducado');
    await send('assistant:decide', { actionId: 'a1', approve: false, token: `ok:${USER}:${ORG}` });
    expect(fetchMock.mock.calls[0]![0]).toBe('http://assistant:3014/assistant/actions/a1/decide');
    expect(sentAuthorization()).toBe(`Bearer ok:${USER}:${ORG}`);
  });

  it('sin autenticador se comporta como antes (token del handshake)', async () => {
    const { send } = setup('del-handshake', false);
    await send('assistant:send', { text: 'hola' });
    expect(sentAuthorization()).toBe('Bearer del-handshake');
  });
});
