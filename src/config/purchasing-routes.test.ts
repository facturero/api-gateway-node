import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { generateKeyPairSync } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildGatewayConfig } from './gateway.config';
import { createGateway } from '../core/create-gateway';
import type { GatewayConfig } from '../core/types';

// Rutas /purchasing/* (compras). Se prueba la configuración REAL de `gateway.config.ts` contra un purchasing-service y un
// plugin-catalog-service de mentira: cada recurso exige SU plugin (proveedores: `inventory.suppliers`; órdenes y ajustes:
// `purchasing.purchase_orders`), el prefijo llega intacto y las órdenes tienen su tope de tamaño.

const ORG = '3f1c8a20-0000-4000-8000-000000000003';
const SUPPLIERS = { pluginCode: 'inventory.suppliers', status: 'active' };
const ORDERS = { pluginCode: 'purchasing.purchase_orders', status: 'active' };

let compras: Server;
let catalogo: Server;
let filasCatalogo: Array<{ pluginCode: string; status: string }> = [];
let recibidas: Array<{ method?: string; url?: string; org?: string }> = [];

beforeAll(async () => {
  const { publicKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  compras = createServer((req, res) => {
    recibidas.push({ method: req.method, url: req.url, org: req.headers['x-organization-id'] as string | undefined });
    req.resume();
    res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}');
  });
  await new Promise<void>((ok) => compras.listen(0, '127.0.0.1', ok));
  catalogo = createServer((req, res) => {
    req.resume();
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(filasCatalogo));
  });
  await new Promise<void>((ok) => catalogo.listen(0, '127.0.0.1', ok));

  process.env.JWT_PUBLIC_KEY = publicKey;
  process.env.JWT_ISSUER = 'test';
  process.env.JWT_AUDIENCE = 'test';
  process.env.AUTH_SERVICE_URL = 'http://auth.invalid:3000';
  process.env.PURCHASING_SERVICE_URL = `http://127.0.0.1:${(compras.address() as AddressInfo).port}`;
  process.env.PLUGIN_CATALOG_SERVICE_URL = `http://127.0.0.1:${(catalogo.address() as AddressInfo).port}`;
});

afterAll(() => {
  compras.close();
  catalogo.close();
});

const autenticador: GatewayConfig['authenticator'] = {
  authenticate: async () => ({
    authenticated: true,
    claims: { sub: 'user-1', email: 'a@b.c', org_id: ORG, permissions: ['*'] },
  }),
};
const env = { incoming: { socket: { remoteAddress: '203.0.113.7', remotePort: 5000, remoteFamily: 'IPv4' } } };
const h = { authorization: 'Bearer x', 'content-type': 'application/json' };

function gateway(plugins: Array<{ pluginCode: string; status: string }> = []) {
  filasCatalogo = plugins;
  const base = buildGatewayConfig();
  return createGateway({ ...base, authenticator: autenticador, rateLimit: { ...base.rateLimit!, max: 10_000 } });
}

describe('declaración de /purchasing/* en el gateway', () => {
  it('no quita el prefijo y cada recurso exige su plugin', () => {
    const config = buildGatewayConfig();
    const regla = (path: string) => config.routes.find((r) => r.path === path);
    for (const path of ['/purchasing/suppliers', '/purchasing/suppliers/*']) {
      expect(regla(path)).toMatchObject({ method: 'ANY', service: 'purchasing-service', stripPrefix: '', requiresPlugin: 'inventory.suppliers' });
    }
    for (const path of ['/purchasing/orders', '/purchasing/orders/*', '/purchasing/settings']) {
      expect(regla(path)).toMatchObject({ method: 'ANY', service: 'purchasing-service', stripPrefix: '', requiresPlugin: 'purchasing.purchase_orders' });
    }
    expect(config.services.some((s) => s.name === 'purchasing-service')).toBe(true);
  });

  it('las órdenes suben el tope a 256 KB', () => {
    const config = buildGatewayConfig();
    for (const path of ['/purchasing/orders', '/purchasing/orders/*']) {
      expect(config.routes.find((r) => r.path === path)).toMatchObject({ maxBodyBytes: 256 * 1024 });
    }
  });
});

describe('corte por plugin de /purchasing/*', () => {
  it('con el plugin activo reenvía con el prefijo intacto y la organización', async () => {
    recibidas = [];
    const app = gateway([SUPPLIERS, ORDERS]);
    expect((await app.request('http://gw/purchasing/suppliers?q=andina', { headers: h }, env)).status).toBe(200);
    expect((await app.request('http://gw/purchasing/orders/abc/approve', { method: 'POST', headers: h, body: '{}' }, env)).status).toBe(200);
    expect(recibidas).toEqual([
      { method: 'GET', url: '/purchasing/suppliers?q=andina', org: ORG },
      { method: 'POST', url: '/purchasing/orders/abc/approve', org: ORG },
    ]);
  });

  it('tener solo proveedores no abre las órdenes, y al revés', async () => {
    recibidas = [];
    const soloProveedores = gateway([SUPPLIERS]);
    expect((await soloProveedores.request('http://gw/purchasing/suppliers', { headers: h }, env)).status).toBe(200);
    for (const ruta of ['/purchasing/orders', '/purchasing/orders/abc', '/purchasing/settings']) {
      const res = await soloProveedores.request(`http://gw${ruta}`, { headers: h }, env);
      expect(res.status, ruta).toBe(403);
      expect(await res.json()).toMatchObject({ code: 'PLUGIN_NOT_ACTIVE' });
    }
    const soloOrdenes = gateway([ORDERS]);
    expect((await soloOrdenes.request('http://gw/purchasing/suppliers/abc', { headers: h }, env)).status).toBe(403);
    expect(recibidas).toHaveLength(1);
  });

  it('sin ningún plugin no llega nada al servicio', async () => {
    recibidas = [];
    const app = gateway([]);
    expect((await app.request('http://gw/purchasing/orders', { method: 'POST', headers: h, body: '{}' }, env)).status).toBe(403);
    expect((await app.request('http://gw/purchasing/suppliers', { headers: h }, env)).status).toBe(403);
    expect(recibidas).toEqual([]);
  });

  it('una orden grande (~200 KB) pasa y una de más de 256 KB responde 413', async () => {
    recibidas = [];
    const app = gateway([SUPPLIERS, ORDERS]);
    const ok = await app.request('http://gw/purchasing/orders', { method: 'POST', headers: h, body: 'x'.repeat(200 * 1024) }, env);
    expect(ok.status).toBe(200);
    const big = await app.request('http://gw/purchasing/orders/abc', { method: 'PUT', headers: h, body: 'x'.repeat(256 * 1024 + 1) }, env);
    expect(big.status).toBe(413);
    expect(recibidas).toHaveLength(1);
  });
});
