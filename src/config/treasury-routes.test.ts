import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { generateKeyPairSync } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildGatewayConfig } from './gateway.config';
import { createGateway } from '../core/create-gateway';
import type { GatewayConfig } from '../core/types';

// Rutas /treasury/* (tesorería/cartera). El servicio sirve el prefijo intacto y exige el plugin
// `finance.accounts_receivable_payable`; cada ruta exige su propio permiso. UNA regla por método y ruta, sin regla general:
// lo que no está declarado responde 404 desde el gateway y nunca llega al servicio.

const ORG = '3f1c8a20-0000-4000-8000-000000000003';
const ID = '3f1c8a20-0000-4000-8000-0000000000aa';
const TREASURY_PLUGIN = { pluginCode: 'finance.accounts_receivable_payable', status: 'active' };

let treasury: Server;
let catalogo: Server;
let filasCatalogo: Array<{ pluginCode: string; status: string }> = [];
let recibidas: Array<{ method?: string; url?: string; org?: string }> = [];

beforeAll(async () => {
  const { publicKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  treasury = createServer((req, res) => {
    recibidas.push({ method: req.method, url: req.url, org: req.headers['x-organization-id'] as string | undefined });
    req.resume();
    res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}');
  });
  await new Promise<void>((ok) => treasury.listen(0, '127.0.0.1', ok));
  catalogo = createServer((req, res) => {
    req.resume();
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(filasCatalogo));
  });
  await new Promise<void>((ok) => catalogo.listen(0, '127.0.0.1', ok));

  process.env.JWT_PUBLIC_KEY = publicKey;
  process.env.JWT_ISSUER = 'test';
  process.env.JWT_AUDIENCE = 'test';
  process.env.AUTH_SERVICE_URL = 'http://auth.invalid:3000';
  process.env.TREASURY_SERVICE_URL = `http://127.0.0.1:${(treasury.address() as AddressInfo).port}`;
  process.env.PLUGIN_CATALOG_SERVICE_URL = `http://127.0.0.1:${(catalogo.address() as AddressInfo).port}`;
});

afterAll(() => {
  treasury.close();
  catalogo.close();
});

// Los permisos del token se cambian por prueba: así se comprueba que el gateway exige el de cada ruta.
let permisosToken: string[] = ['*'];
let autenticado = true;
const autenticador: GatewayConfig['authenticator'] = {
  authenticate: async () =>
    autenticado
      ? { authenticated: true, claims: { sub: 'user-1', email: 'a@b.c', org_id: ORG, permissions: permisosToken } }
      : ({ authenticated: false, error: 'sin token' } as never),
};
const env = { incoming: { socket: { remoteAddress: '203.0.113.7', remotePort: 5000, remoteFamily: 'IPv4' } } };
const h = { authorization: 'Bearer x', 'content-type': 'application/json' };

function gateway(plugins: Array<{ pluginCode: string; status: string }> = []) {
  filasCatalogo = plugins;
  autenticado = true;
  const base = buildGatewayConfig();
  return createGateway({ ...base, authenticator: autenticador, rateLimit: { ...base.rateLimit!, max: 10_000 } });
}

const RUTAS: { method: string; path: string; patron: string; permiso: string; body?: string }[] = [
  { method: 'GET', path: '/treasury/receivables', patron: '/treasury/receivables', permiso: 'receivable:read' },
  { method: 'GET', path: '/treasury/receivables/aging', patron: '/treasury/receivables/aging', permiso: 'receivable:read' },
  { method: 'GET', path: `/treasury/receivables/${ID}`, patron: '/treasury/receivables/:id', permiso: 'receivable:read' },
  { method: 'GET', path: `/treasury/customers/${ID}/statement`, patron: '/treasury/customers/:id/statement', permiso: 'receivable:read' },
  { method: 'GET', path: `/treasury/customers/${ID}/terms`, patron: '/treasury/customers/:id/terms', permiso: 'receivable:read' },
  { method: 'PUT', path: `/treasury/customers/${ID}/terms`, patron: '/treasury/customers/:id/terms', permiso: 'customer_terms:manage', body: '{"creditDays":30,"creditLimitCents":null}' },
  { method: 'POST', path: '/treasury/opening-balances', patron: '/treasury/opening-balances', permiso: 'opening_balance:load', body: '{"cutoffDate":"2026-10-01","reason":"inicio","lines":[]}' },
  { method: 'GET', path: '/treasury/receipts', patron: '/treasury/receipts', permiso: 'receipt:read' },
  { method: 'GET', path: `/treasury/receipts/${ID}`, patron: '/treasury/receipts/:id', permiso: 'receipt:read' },
  { method: 'POST', path: '/treasury/receipts', patron: '/treasury/receipts', permiso: 'receipt:create', body: '{}' },
  { method: 'PUT', path: `/treasury/receipts/${ID}`, patron: '/treasury/receipts/:id', permiso: 'receipt:create', body: '{}' },
  { method: 'POST', path: `/treasury/receipts/${ID}/post`, patron: '/treasury/receipts/:id/post', permiso: 'receipt:create' },
  { method: 'POST', path: `/treasury/receipts/${ID}/void`, patron: '/treasury/receipts/:id/void', permiso: 'receipt:void', body: '{"reason":"duplicado"}' },
  { method: 'GET', path: '/treasury/receivables/export', patron: '/treasury/receivables/export', permiso: 'receivable:export' },
  { method: 'GET', path: '/treasury/receivables/aging/export', patron: '/treasury/receivables/aging/export', permiso: 'receivable:export' },
  { method: 'GET', path: `/treasury/customers/${ID}/statement/export`, patron: '/treasury/customers/:id/statement/export', permiso: 'receivable:export' },
  { method: 'GET', path: '/treasury/reminders/settings', patron: '/treasury/reminders/settings', permiso: 'reminder:manage' },
  { method: 'PUT', path: '/treasury/reminders/settings', patron: '/treasury/reminders/settings', permiso: 'reminder:manage', body: '{}' },
  { method: 'GET', path: '/treasury/reminders/preview', patron: '/treasury/reminders/preview', permiso: 'reminder:manage' },
  { method: 'POST', path: '/treasury/reminders/run', patron: '/treasury/reminders/run', permiso: 'reminder:manage' },
  { method: 'GET', path: '/treasury/payables', patron: '/treasury/payables', permiso: 'payable:read' },
  { method: 'GET', path: `/treasury/payables/${ID}`, patron: '/treasury/payables/:id', permiso: 'payable:read' },
  { method: 'GET', path: '/treasury/payables/aging', patron: '/treasury/payables/aging', permiso: 'payable:read' },
  { method: 'GET', path: '/treasury/payables/export', patron: '/treasury/payables/export', permiso: 'payable:export' },
  { method: 'GET', path: '/treasury/payables/aging/export', patron: '/treasury/payables/aging/export', permiso: 'payable:export' },
  { method: 'GET', path: `/treasury/suppliers/${ID}/statement`, patron: '/treasury/suppliers/:id/statement', permiso: 'payable:read' },
  { method: 'GET', path: `/treasury/suppliers/${ID}/statement/export`, patron: '/treasury/suppliers/:id/statement/export', permiso: 'payable:export' },
  { method: 'POST', path: '/treasury/payable-opening-balances', patron: '/treasury/payable-opening-balances', permiso: 'opening_balance:load', body: '{}' },
  { method: 'GET', path: '/treasury/payments', patron: '/treasury/payments', permiso: 'payment:read' },
  { method: 'GET', path: '/treasury/payments/settings', patron: '/treasury/payments/settings', permiso: 'payment:approve' },
  { method: 'PUT', path: '/treasury/payments/settings', patron: '/treasury/payments/settings', permiso: 'payment:approve', body: '{}' },
  { method: 'GET', path: `/treasury/payments/${ID}`, patron: '/treasury/payments/:id', permiso: 'payment:read' },
  { method: 'POST', path: '/treasury/payments', patron: '/treasury/payments', permiso: 'payment:create', body: '{}' },
  { method: 'PUT', path: `/treasury/payments/${ID}`, patron: '/treasury/payments/:id', permiso: 'payment:create', body: '{}' },
  { method: 'POST', path: `/treasury/payments/${ID}/approve`, patron: '/treasury/payments/:id/approve', permiso: 'payment:approve' },
  { method: 'POST', path: `/treasury/payments/${ID}/post`, patron: '/treasury/payments/:id/post', permiso: 'payment:create' },
  { method: 'POST', path: `/treasury/payments/${ID}/void`, patron: '/treasury/payments/:id/void', permiso: 'payment:void', body: '{"reason":"duplicado"}' },
];

const llamar = (app: ReturnType<typeof gateway>, r: { method: string; path: string; body?: string }, headers: Record<string, string> = h) =>
  app.request(`http://gw${r.path}`, { method: r.method, headers, body: r.body }, env);

describe('declaración de /treasury/* en el gateway', () => {
  it('registra el servicio y UNA regla por método y ruta, cada una con plugin y permiso', () => {
    const config = buildGatewayConfig();
    expect(config.services.some((s) => s.name === 'treasury-service')).toBe(true);
    const reglas = config.routes.filter((r) => r.service === 'treasury-service');
    expect(reglas).toHaveLength(RUTAS.length);
    for (const r of reglas) {
      expect(r.requiresPlugin, r.path).toBe('finance.accounts_receivable_payable');
      expect(r.permission, `${r.method} ${r.path} sin permiso`).toBeTruthy();
      expect(r.stripPrefix, r.path).toBe('');
      expect(r.method, `${r.path} no debe ser ANY`).not.toBe('ANY');
    }
  });

  it('NO hay regla general `/treasury/*`: lo que no está declarado no llega al servicio', () => {
    expect(buildGatewayConfig().routes.some((r) => r.path === '/treasury/*')).toBe(false);
  });

  it('cada regla declara el método y el permiso que le corresponden', () => {
    const config = buildGatewayConfig();
    for (const ruta of RUTAS) {
      const regla = config.routes.find((r) => r.method === ruta.method && r.path === ruta.patron);
      expect(regla, `${ruta.method} ${ruta.patron}`).toMatchObject({ permission: ruta.permiso, service: 'treasury-service' });
    }
    expect(config.routes.find((r) => r.path === '/treasury/opening-balances')).toMatchObject({ maxBodyBytes: 256 * 1024 });
  });

  it('`aging` va antes que `receivables/*` (si no, «aging» se leería como un id)', () => {
    const reglas = buildGatewayConfig().routes.filter((r) => r.service === 'treasury-service');
    expect(reglas.findIndex((r) => r.path === '/treasury/receivables/aging')).toBeLessThan(reglas.findIndex((r) => r.path === '/treasury/receivables/:id'));
  });
});

describe('corte por plugin de /treasury/*', () => {
  it('con el plugin activo reenvía con el prefijo intacto y la organización', async () => {
    recibidas = [];
    permisosToken = ['*'];
    const app = gateway([TREASURY_PLUGIN]);
    for (const ruta of RUTAS) expect((await llamar(app, ruta)).status, `${ruta.method} ${ruta.path}`).toBe(200);
    expect(recibidas).toHaveLength(RUTAS.length);
    for (const r of recibidas) {
      expect(r.url?.startsWith('/treasury/')).toBe(true);
      expect(r.org).toBe(ORG);
    }
  });

  it('sin el plugin responde 403 en TODAS las rutas y no llega nada al servicio', async () => {
    recibidas = [];
    permisosToken = ['*'];
    const app = gateway([]);
    for (const ruta of RUTAS) expect((await llamar(app, ruta)).status, `${ruta.method} ${ruta.path}`).toBe(403);
    expect(recibidas).toEqual([]);
  });

  it('con el plugin DESACTIVADO también responde 403', async () => {
    recibidas = [];
    const app = gateway([{ pluginCode: 'finance.accounts_receivable_payable', status: 'inactive' }]);
    expect((await llamar(app, RUTAS[0]!)).status).toBe(403);
    expect(recibidas).toEqual([]);
  });
});

describe('permisos en el gateway', () => {
  it.each(RUTAS)('$method $path exige $permiso: sin él 403 y no llega al servicio; con él pasa', async (ruta) => {
    const app = gateway([TREASURY_PLUGIN]);
    recibidas = [];
    permisosToken = ['invoice:read', 'receivable:read', 'customer_terms:manage', 'opening_balance:load', 'receipt:read', 'receipt:create', 'receipt:void'].filter((p) => p !== ruta.permiso);
    expect((await llamar(app, ruta)).status).toBe(403);
    expect(recibidas).toEqual([]);

    permisosToken = [ruta.permiso];
    expect((await llamar(app, ruta)).status).toBe(200);
    expect(recibidas).toHaveLength(1);
  });

  it('un cliente que manda `X-Permissions: *` o el `X-Organization-Id` de otra organización no obtiene nada: valen los del token', async () => {
    const app = gateway([TREASURY_PLUGIN]);
    permisosToken = ['receivable:read'];
    recibidas = [];
    const falsas = { ...h, 'x-permissions': '*', 'x-organization-id': '3f1c8a20-0000-4000-8000-0000000000ff' };
    expect((await llamar(app, RUTAS[5]!, falsas)).status).toBe(403); // customer_terms:manage: el token no lo tiene
    expect((await llamar(app, RUTAS[0]!, falsas)).status).toBe(200);
    expect(recibidas).toHaveLength(1);
    expect(recibidas[0]!.org).toBe(ORG);
  });

  it('sin token → 401 y no llega nada al servicio', async () => {
    recibidas = [];
    const app = gateway([TREASURY_PLUGIN]);
    autenticado = false;
    expect((await llamar(app, RUTAS[0]!)).status).toBe(401);
    expect(recibidas).toEqual([]);
  });
});

describe('lo que NO está declarado no llega al servicio', () => {
  it('una ruta desconocida responde 404 desde el gateway (con todos los permisos y el plugin activo)', async () => {
    recibidas = [];
    permisosToken = ['*'];
    const app = gateway([TREASURY_PLUGIN]);
    for (const [method, path] of [['GET', '/treasury/otra-cosa'], ['GET', '/treasury'], ['DELETE', '/treasury/receipts/x'], ['PATCH', '/treasury/receipts/x'], ['POST', '/treasury/payables'], ['GET', '/treasury/receipts/x/post'], ['DELETE', '/treasury/payments/x'], ['GET', '/treasury/payments/x/post'], ['POST', '/treasury/payables/x/pay'], ['PATCH', '/treasury/payments/settings'], ['GET', '/treasury/suppliers/x/statement/otra']] as const) {
      expect((await app.request(`http://gw${path}`, { method, headers: h }, env)).status, `${method} ${path}`).toBe(404);
    }
    expect(recibidas).toEqual([]);
  });

  it('escribir sobre la cartera (POST/PUT/PATCH/DELETE en /treasury/receivables) no pasa, ni con `receivable:read` ni con todo', async () => {
    recibidas = [];
    const app = gateway([TREASURY_PLUGIN]);
    for (const permisos of [['receivable:read'], ['*']]) {
      permisosToken = permisos;
      for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
        for (const path of ['/treasury/receivables', `/treasury/receivables/${ID}`, '/treasury/receivables/aging']) {
          const res = await app.request(`http://gw${path}`, { method, headers: h, body: method === 'DELETE' ? undefined : '{}' }, env);
          expect(res.status, `${method} ${path} con ${permisos}`).toBe(404);
        }
      }
    }
    expect(recibidas).toEqual([]);
  });

  it('el método equivocado en una ruta de escritura tampoco pasa (GET opening-balances, POST y DELETE terms)', async () => {
    recibidas = [];
    permisosToken = ['*'];
    const app = gateway([TREASURY_PLUGIN]);
    expect((await app.request('http://gw/treasury/opening-balances', { method: 'GET', headers: h }, env)).status).toBe(404);
    expect((await app.request(`http://gw/treasury/customers/${ID}/terms`, { method: 'POST', headers: h, body: '{}' }, env)).status).toBe(404);
    expect((await app.request(`http://gw/treasury/customers/${ID}/terms`, { method: 'DELETE', headers: h }, env)).status).toBe(404);
    expect(recibidas).toEqual([]);
  });

  it('un cuerpo de más de 256 KB en saldos iniciales responde 413 sin llegar al servicio', async () => {
    recibidas = [];
    permisosToken = ['*'];
    const app = gateway([TREASURY_PLUGIN]);
    const grande = JSON.stringify({ cutoffDate: '2026-10-01', reason: 'x'.repeat(300 * 1024), lines: [] });
    const res = await app.request('http://gw/treasury/opening-balances', { method: 'POST', headers: { ...h, 'content-length': String(grande.length) }, body: grande }, env);
    expect(res.status).toBe(413);
    expect(recibidas).toEqual([]);
  });
});

describe('cobros: separación de funciones en el gateway', () => {
  it('quien tiene `receipt:create` (cobrar, contabilizar) NO puede anular: el gateway lo corta con 403 y no llega al servicio', async () => {
    recibidas = [];
    permisosToken = ['receipt:read', 'receipt:create'];
    const app = gateway([TREASURY_PLUGIN]);
    expect((await app.request(`http://gw/treasury/receipts/${ID}/post`, { method: 'POST', headers: h }, env)).status).toBe(200);
    recibidas = [];
    expect((await app.request(`http://gw/treasury/receipts/${ID}/void`, { method: 'POST', headers: h, body: '{"reason":"intento"}' }, env)).status).toBe(403);
    expect(recibidas).toEqual([]);
  });

  it('el rol de solo lectura ve los cobros pero no crea ni contabiliza', async () => {
    recibidas = [];
    permisosToken = ['receipt:read'];
    const app = gateway([TREASURY_PLUGIN]);
    expect((await app.request('http://gw/treasury/receipts', { headers: h }, env)).status).toBe(200);
    expect((await app.request('http://gw/treasury/receipts', { method: 'POST', headers: h, body: '{}' }, env)).status).toBe(403);
    expect((await app.request(`http://gw/treasury/receipts/${ID}/post`, { method: 'POST', headers: h }, env)).status).toBe(403);
    expect(recibidas).toHaveLength(1);
  });
});
