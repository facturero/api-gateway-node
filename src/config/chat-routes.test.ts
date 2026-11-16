import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { generateKeyPairSync } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildGatewayConfig } from './gateway.config';
import { createGateway } from '../core/create-gateway';
import type { GatewayConfig } from '../core/types';

// Ruta /chat/* (mensajería, módulo `comm.internal_chat`, del núcleo). Se prueba la regla REAL contra un chat-service y un catálogo locales:
// sin el módulo, 403 y no llega; con él, reenvía con el prefijo intacto SIN exigir permiso (cualquier miembro usa el chat; quién lee qué
// lo decide chat-service). `/internal/*` de chat-service no tiene entrada aquí: lo llama el hub directo.

const ORG = '3f1c8a20-0000-4000-8000-000000000003';
const CHAT = { pluginCode: 'comm.internal_chat', status: 'active' };

let chat: Server;
let catalogo: Server;
let filasCatalogo: Array<{ pluginCode: string; status: string }> = [];
let recibidas: Array<{ method?: string; url?: string; org?: string; user?: string }> = [];

beforeAll(async () => {
  const { publicKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  chat = createServer((req, res) => {
    recibidas.push({ method: req.method, url: req.url, org: req.headers['x-organization-id'] as string | undefined, user: req.headers['x-user-id'] as string | undefined });
    req.resume();
    res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}');
  });
  await new Promise<void>((ok) => chat.listen(0, '127.0.0.1', ok));
  catalogo = createServer((req, res) => {
    req.resume();
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(filasCatalogo));
  });
  await new Promise<void>((ok) => catalogo.listen(0, '127.0.0.1', ok));

  process.env.JWT_PUBLIC_KEY = publicKey;
  process.env.JWT_ISSUER = 'test';
  process.env.JWT_AUDIENCE = 'test';
  process.env.AUTH_SERVICE_URL = 'http://auth.invalid:3000';
  process.env.CHAT_SERVICE_URL = `http://127.0.0.1:${(chat.address() as AddressInfo).port}`;
  process.env.PLUGIN_CATALOG_SERVICE_URL = `http://127.0.0.1:${(catalogo.address() as AddressInfo).port}`;
});

afterAll(() => {
  chat.close();
  catalogo.close();
});

const env = { incoming: { socket: { remoteAddress: '203.0.113.7', remotePort: 5000, remoteFamily: 'IPv4' } } };

function gateway(plugins: Array<{ pluginCode: string; status: string }>, permissions: string[] = []) {
  filasCatalogo = plugins;
  const autenticador: GatewayConfig['authenticator'] = {
    authenticate: async () => ({ authenticated: true, claims: { sub: 'user-1', email: 'a@b.c', org_id: ORG, permissions } }),
  };
  const base = buildGatewayConfig();
  return createGateway({ ...base, authenticator: autenticador, rateLimit: { ...base.rateLimit!, max: 10_000 } });
}

const call = (gw: ReturnType<typeof gateway>, method: string, path: string) =>
  gw.request(`http://gw${path}`, { method, headers: { authorization: 'Bearer x', 'content-type': 'application/json' }, body: method === 'GET' ? undefined : '{}' }, env);

describe('ruta /chat/* en el gateway', () => {
  it('se declara con el módulo del núcleo, sin permiso y sin quitar el prefijo', () => {
    const config = buildGatewayConfig();
    const rule = config.routes.find((r) => r.path === '/chat/*');
    expect(rule).toMatchObject({ method: 'ANY', service: 'chat-service', stripPrefix: '', requiresPlugin: 'comm.internal_chat' });
    expect(rule?.permission).toBeUndefined();
    expect(config.services.find((s) => s.name === 'chat-service')).toBeDefined();
    expect(config.routes.some((r) => r.path.startsWith('/internal'))).toBe(false);
  });

  it('sin el módulo activo: 403 y no llega al servicio', async () => {
    recibidas = [];
    expect((await call(gateway([]), 'GET', '/chat/conversations')).status).toBe(403);
    expect(recibidas).toEqual([]);
  });

  it('con el módulo y sin ningún permiso: reenvía con el prefijo intacto y el actor', async () => {
    recibidas = [];
    const gw = gateway([CHAT]);
    expect((await call(gw, 'GET', '/chat/conversations')).status).toBe(200);
    expect((await call(gw, 'POST', '/chat/conversations/3f1c8a20-0000-4000-8000-0000000000aa/messages')).status).toBe(200);
    expect(recibidas.map((r) => `${r.method} ${r.url}`)).toEqual(['GET /chat/conversations', 'POST /chat/conversations/3f1c8a20-0000-4000-8000-0000000000aa/messages']);
    expect(recibidas[0]).toMatchObject({ org: ORG, user: 'user-1' });
  });
});
