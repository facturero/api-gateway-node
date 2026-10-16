import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { generateKeyPairSync } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildGatewayConfig } from './gateway.config';
import { createGateway } from '../core/create-gateway';
import type { GatewayConfig } from '../core/types';

// Rutas /fiscal/* (retenciones y guías de remisión, bajo `finance.electronic_invoicing`). Se prueba la configuración REAL del
// gateway contra un fiscal-ecuador y un plugin-catalog de mentira: corte por plugin, prefijo intacto y tope de tamaño.

const ORG = '3f1c8a20-0000-4000-8000-000000000002';
const ACTIVO = { pluginCode: 'finance.electronic_invoicing', status: 'active' };

let fiscal: Server;
let catalogo: Server;
let filasCatalogo: Array<{ pluginCode: string; status: string }> = [];
let recibidas: Array<{ method?: string; url?: string; org?: string }> = [];

beforeAll(async () => {
  const { publicKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  fiscal = createServer((req, res) => {
    recibidas.push({ method: req.method, url: req.url, org: req.headers['x-organization-id'] as string | undefined });
    req.resume();
    res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}');
  });
  await new Promise<void>((ok) => fiscal.listen(0, '127.0.0.1', ok));
  catalogo = createServer((req, res) => {
    req.resume();
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(filasCatalogo));
  });
  await new Promise<void>((ok) => catalogo.listen(0, '127.0.0.1', ok));

  process.env.JWT_PUBLIC_KEY = publicKey;
  process.env.JWT_ISSUER = 'test';
  process.env.JWT_AUDIENCE = 'test';
  process.env.AUTH_SERVICE_URL = 'http://auth.invalid:3000';
  process.env.FISCAL_SERVICE_URL = `http://127.0.0.1:${(fiscal.address() as AddressInfo).port}`;
  process.env.PLUGIN_CATALOG_SERVICE_URL = `http://127.0.0.1:${(catalogo.address() as AddressInfo).port}`;
});

afterAll(() => {
  fiscal.close();
  catalogo.close();
});

const autenticador: GatewayConfig['authenticator'] = {
  authenticate: async () => ({
    authenticated: true,
    claims: { sub: 'user-1', email: 'a@b.c', org_id: ORG, permissions: ['*'] },
  }),
};
const env = { incoming: { socket: { remoteAddress: '203.0.113.7', remotePort: 5000, remoteFamily: 'IPv4' } } };

function gateway(plugins: Array<{ pluginCode: string; status: string }> = []) {
  filasCatalogo = plugins;
  const base = buildGatewayConfig();
  return createGateway({ ...base, authenticator: autenticador, rateLimit: { ...base.rateLimit!, max: 10_000 } });
}

describe('declaración de /fiscal/* en el gateway', () => {
  it('no quita el prefijo, exige la facturación electrónica y sube el tope a 512 KB', () => {
    const config = buildGatewayConfig();
    expect(config.routes.find((r) => r.path === '/fiscal/*')).toMatchObject({
      method: 'ANY',
      service: 'fiscal-ecuador',
      stripPrefix: '',
      requiresPlugin: 'finance.electronic_invoicing',
      maxBodyBytes: 512 * 1024,
    });
  });
});

describe('corte por plugin de /fiscal/*', () => {
  it('con el plugin activo reenvía con el prefijo intacto', async () => {
    recibidas = [];
    const h = { authorization: 'Bearer x', 'content-type': 'application/json' };
    const res = await gateway([ACTIVO]).request('http://gw/fiscal/withholdings', { method: 'POST', headers: h, body: '{}' }, env);
    expect(res.status).toBe(200);
    expect(recibidas).toEqual([{ method: 'POST', url: '/fiscal/withholdings', org: ORG }]);
  });

  it('sin el plugin responde 403 PLUGIN_NOT_ACTIVE y no llega al servicio', async () => {
    recibidas = [];
    const res = await gateway([]).request('http://gw/fiscal/delivery-guides', { method: 'POST', headers: { authorization: 'Bearer x' }, body: '{}' }, env);
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: 'PLUGIN_NOT_ACTIVE' });
    expect(recibidas).toEqual([]);
  });

  it('un cuerpo de más de 512 KB responde 413', async () => {
    recibidas = [];
    const h = { authorization: 'Bearer x', 'content-type': 'application/json' };
    const res = await gateway([ACTIVO]).request('http://gw/fiscal/delivery-guides', { method: 'POST', headers: h, body: 'x'.repeat(512 * 1024 + 1) }, env);
    expect(res.status).toBe(413);
    expect(recibidas).toEqual([]);
  });
});
