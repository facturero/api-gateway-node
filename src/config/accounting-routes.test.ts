import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { generateKeyPairSync } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildGatewayConfig } from './gateway.config';
import { createGateway } from '../core/create-gateway';
import type { GatewayConfig } from '../core/types';

// Rutas /accounting/* (módulo de pago `finance.general_ledger`). Se prueba la configuración REAL de `gateway.config.ts` contra un
// accounting-service y un plugin-catalog-service de mentira: el corte por plugin, el prefijo intacto y el tope de tamaño de los
// asientos (hasta 500 líneas), que va ANTES del comodín.

const ORG = '3f1c8a20-0000-4000-8000-000000000001';
const ACTIVO = { pluginCode: 'finance.general_ledger', status: 'active' };

let contabilidad: Server;
let catalogo: Server;
let filasCatalogo: Array<{ pluginCode: string; status: string }> = [];
let recibidas: Array<{ method?: string; url?: string; org?: string }> = [];

beforeAll(async () => {
  const { publicKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  contabilidad = createServer((req, res) => {
    recibidas.push({ method: req.method, url: req.url, org: req.headers['x-organization-id'] as string | undefined });
    req.resume();
    res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}');
  });
  await new Promise<void>((ok) => contabilidad.listen(0, '127.0.0.1', ok));
  catalogo = createServer((req, res) => {
    req.resume();
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(filasCatalogo));
  });
  await new Promise<void>((ok) => catalogo.listen(0, '127.0.0.1', ok));

  process.env.JWT_PUBLIC_KEY = publicKey;
  process.env.JWT_ISSUER = 'test';
  process.env.JWT_AUDIENCE = 'test';
  process.env.AUTH_SERVICE_URL = 'http://auth.invalid:3000';
  process.env.ACCOUNTING_SERVICE_URL = `http://127.0.0.1:${(contabilidad.address() as AddressInfo).port}`;
  process.env.PLUGIN_CATALOG_SERVICE_URL = `http://127.0.0.1:${(catalogo.address() as AddressInfo).port}`;
});

afterAll(() => {
  contabilidad.close();
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

describe('declaración de /accounting/* en el gateway', () => {
  it('no quita el prefijo y exige el plugin finance.general_ledger', () => {
    const config = buildGatewayConfig();
    expect(config.routes.find((r) => r.path === '/accounting/*')).toMatchObject({
      method: 'ANY',
      service: 'accounting-service',
      stripPrefix: '',
      requiresPlugin: 'finance.general_ledger',
    });
    expect(config.services.some((s) => s.name === 'accounting-service')).toBe(true);
  });

  it('las reglas de asientos suben el tope a 512 KB y van antes del comodín', () => {
    const config = buildGatewayConfig();
    const comodin = config.routes.findIndex((r) => r.path === '/accounting/*');
    for (const path of ['/accounting/journal-entries', '/accounting/journal-entries/:id']) {
      const regla = config.routes.find((r) => r.path === path);
      expect(regla).toMatchObject({ requiresPlugin: 'finance.general_ledger', maxBodyBytes: 512 * 1024 });
      expect(config.routes.indexOf(regla!)).toBeLessThan(comodin);
    }
  });
});

describe('corte por plugin de /accounting/*', () => {
  it('con el plugin activo reenvía con el prefijo intacto', async () => {
    recibidas = [];
    const res = await gateway([ACTIVO]).request('http://gw/accounting/accounts', { headers: { authorization: 'Bearer x' } }, env);
    expect(res.status).toBe(200);
    expect(recibidas).toEqual([{ method: 'GET', url: '/accounting/accounts', org: ORG }]);
  });

  it('sin el plugin responde 403 PLUGIN_NOT_ACTIVE y no llega al servicio', async () => {
    recibidas = [];
    const h = { authorization: 'Bearer x', 'content-type': 'application/json' };
    const app = gateway([]);
    const res = await app.request('http://gw/accounting/accounts', { headers: h }, env);
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: 'PLUGIN_NOT_ACTIVE' });
    expect((await app.request('http://gw/accounting/journal-entries', { method: 'POST', headers: h, body: '{}' }, env)).status).toBe(403);
    expect(recibidas).toEqual([]);
  });

  it('un asiento grande (~300 KB) pasa y uno de más de 512 KB responde 413', async () => {
    recibidas = [];
    const h = { authorization: 'Bearer x', 'content-type': 'application/json' };
    const app = gateway([ACTIVO]);
    const ok = await app.request('http://gw/accounting/journal-entries', { method: 'POST', headers: h, body: 'x'.repeat(300 * 1024) }, env);
    expect(ok.status).toBe(200);
    const big = await app.request('http://gw/accounting/journal-entries/abc', { method: 'PUT', headers: h, body: 'x'.repeat(512 * 1024 + 1) }, env);
    expect(big.status).toBe(413);
    expect(recibidas).toHaveLength(1);
  });
});
