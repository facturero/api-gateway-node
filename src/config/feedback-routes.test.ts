import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { generateKeyPairSync } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildGatewayConfig } from './gateway.config';
import { createGateway } from '../core/create-gateway';
import type { GatewayConfig } from '../core/types';

// Ruta /feedback/* (comentarios, mejoras y puntos, feedback-service). Se prueba la regla REAL contra un feedback-service local: sin módulo
// ni permiso, con sesión reenvía con el prefijo intacto (también `/feedback` a secas); la bandeja de todas las empresas la cuida el
// servicio con `feedback:manage`, así que el gateway no la filtra.

const ORG = '3f1c8a20-0000-4000-8000-000000000004';
let svc: Server;
let recibidas: Array<{ method?: string; url?: string; org?: string; perms?: string }> = [];

beforeAll(async () => {
  const { publicKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  svc = createServer((req, res) => {
    recibidas.push({ method: req.method, url: req.url, org: req.headers['x-organization-id'] as string | undefined, perms: req.headers['x-permissions'] as string | undefined });
    req.resume();
    res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}');
  });
  await new Promise<void>((ok) => svc.listen(0, '127.0.0.1', ok));
  process.env.JWT_PUBLIC_KEY = publicKey;
  process.env.JWT_ISSUER = 'test';
  process.env.JWT_AUDIENCE = 'test';
  process.env.AUTH_SERVICE_URL = 'http://auth.invalid:3000';
  process.env.FEEDBACK_SERVICE_URL = `http://127.0.0.1:${(svc.address() as AddressInfo).port}`;
});

afterAll(() => {
  svc.close();
});

const env = { incoming: { socket: { remoteAddress: '203.0.113.8', remotePort: 5000, remoteFamily: 'IPv4' } } };

function gateway(permissions: string[] = []) {
  const autenticador: GatewayConfig['authenticator'] = {
    authenticate: async () => ({ authenticated: true, claims: { sub: 'user-1', email: 'a@b.c', org_id: ORG, permissions } }),
  };
  const base = buildGatewayConfig();
  return createGateway({ ...base, authenticator: autenticador, rateLimit: { ...base.rateLimit!, max: 10_000 } });
}

const call = (gw: ReturnType<typeof gateway>, method: string, path: string) =>
  gw.request(`http://gw${path}`, { method, headers: { authorization: 'Bearer x', 'content-type': 'application/json' }, body: method === 'GET' ? undefined : '{}' }, env);

describe('ruta /feedback/* en el gateway', () => {
  it('se declara sin módulo ni permiso y sin quitar el prefijo', () => {
    const config = buildGatewayConfig();
    const rule = config.routes.find((r) => r.path === '/feedback/*');
    expect(rule).toMatchObject({ method: 'ANY', service: 'feedback-service', stripPrefix: '' });
    expect(rule?.permission).toBeUndefined();
    expect(rule?.requiresPlugin).toBeUndefined();
    expect(config.services.find((s) => s.name === 'feedback-service')).toBeDefined();
  });

  it('con sesión y sin permisos: reenvía `/feedback` y sus subrutas con el actor y sus permisos', async () => {
    recibidas = [];
    const gw = gateway();
    expect((await call(gw, 'POST', '/feedback')).status).toBe(200);
    expect((await call(gw, 'GET', '/feedback/points')).status).toBe(200);
    expect(recibidas.map((r) => `${r.method} ${r.url}`)).toEqual(['POST /feedback', 'GET /feedback/points']);
    expect(recibidas[0].org).toBe(ORG);
    recibidas = [];
    await call(gateway(['feedback:manage']), 'GET', '/feedback/admin/items');
    expect(recibidas[0]?.perms).toContain('feedback:manage');
  });
});
