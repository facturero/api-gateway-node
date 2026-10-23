import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { generateKeyPairSync } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildGatewayConfig } from './gateway.config';
import { createGateway } from '../core/create-gateway';
import type { GatewayConfig } from '../core/types';

// Rutas /reporting/* (anexos del SRI). El servicio sirve el prefijo intacto y exige el plugin `compliance.sri_annexes`; cada ruta exige
// su propio permiso (ver, generar y descargar son tres cosas distintas). UNA regla por método y ruta, sin regla general: lo que no está
// declarado responde 404 desde el gateway y nunca llega al servicio.

const ORG = '3f1c8a20-0000-4000-8000-000000000003';
const ID = '3f1c8a20-0000-4000-8000-0000000000aa';
const PLUGIN = { pluginCode: 'compliance.sri_annexes', status: 'active' };

let reporting: Server;
let catalogo: Server;
let filasCatalogo: Array<{ pluginCode: string; status: string }> = [];
let recibidas: Array<{ method?: string; url?: string; org?: string }> = [];

beforeAll(async () => {
  const { publicKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  reporting = createServer((req, res) => {
    recibidas.push({ method: req.method, url: req.url, org: req.headers['x-organization-id'] as string | undefined });
    req.resume();
    res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}');
  });
  await new Promise<void>((ok) => reporting.listen(0, '127.0.0.1', ok));
  catalogo = createServer((req, res) => {
    req.resume();
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(filasCatalogo));
  });
  await new Promise<void>((ok) => catalogo.listen(0, '127.0.0.1', ok));

  process.env.JWT_PUBLIC_KEY = publicKey;
  process.env.JWT_ISSUER = 'test';
  process.env.JWT_AUDIENCE = 'test';
  process.env.AUTH_SERVICE_URL = 'http://auth.invalid:3000';
  process.env.REPORTING_SERVICE_URL = `http://127.0.0.1:${(reporting.address() as AddressInfo).port}`;
  process.env.PLUGIN_CATALOG_SERVICE_URL = `http://127.0.0.1:${(catalogo.address() as AddressInfo).port}`;
});

afterAll(() => {
  reporting.close();
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
  { method: 'GET', path: '/reporting/annexes/runs', patron: '/reporting/annexes/runs', permiso: 'tax_annex:read' },
  { method: 'GET', path: `/reporting/annexes/runs/${ID}/export?format=csv`, patron: '/reporting/annexes/runs/:id/export', permiso: 'tax_annex:export' },
  { method: 'GET', path: `/reporting/annexes/runs/${ID}`, patron: '/reporting/annexes/runs/:id', permiso: 'tax_annex:read' },
  { method: 'POST', path: '/reporting/annexes/f104/2026-10/generate', patron: '/reporting/annexes/:annex/:period/generate', permiso: 'tax_annex:generate' },
  { method: 'GET', path: '/reporting/annexes/f104/2026-10/reconciliation', patron: '/reporting/annexes/:annex/:period/reconciliation', permiso: 'tax_annex:read' },
  { method: 'GET', path: '/reporting/annexes/f104/2026-10/manual-inputs', patron: '/reporting/annexes/:annex/:period/manual-inputs', permiso: 'tax_annex:read' },
  { method: 'PUT', path: '/reporting/annexes/f104/2026-10/manual-inputs/credito_anterior', patron: '/reporting/annexes/:annex/:period/manual-inputs/:fieldCode', permiso: 'tax_annex:generate', body: '{"amountCents":500}' },
  { method: 'GET', path: '/reporting/documents', patron: '/reporting/documents', permiso: 'tax_annex:read' },
];

const llamar = (app: ReturnType<typeof gateway>, r: { method: string; path: string; body?: string }, headers: Record<string, string> = h) =>
  app.request(`http://gw${r.path}`, { method: r.method, headers, body: r.body }, env);

describe('declaración de /reporting/* en el gateway', () => {
  it('registra el servicio y UNA regla por método y ruta, cada una con plugin y permiso', () => {
    const config = buildGatewayConfig();
    expect(config.services.some((s) => s.name === 'reporting-service')).toBe(true);
    const reglas = config.routes.filter((r) => r.service === 'reporting-service');
    expect(reglas).toHaveLength(RUTAS.length);
    for (const r of reglas) {
      expect(r.requiresPlugin, r.path).toBe('compliance.sri_annexes');
      expect(r.permission, `${r.method} ${r.path} sin permiso`).toBeTruthy();
      expect(r.stripPrefix, r.path).toBe('');
      expect(r.method, `${r.path} no debe ser ANY`).not.toBe('ANY');
    }
  });

  it('NO hay regla general `/reporting/*`', () => {
    expect(buildGatewayConfig().routes.some((r) => r.path === '/reporting/*')).toBe(false);
  });

  it('cada regla declara el método y el permiso que le corresponden; los cuerpos son chicos', () => {
    const config = buildGatewayConfig();
    for (const ruta of RUTAS) {
      const regla = config.routes.find((r) => r.method === ruta.method && r.path === ruta.patron);
      expect(regla, `${ruta.method} ${ruta.patron}`).toMatchObject({ permission: ruta.permiso, service: 'reporting-service' });
    }
    for (const r of config.routes.filter((x) => x.service === 'reporting-service' && ['POST', 'PUT'].includes(x.method))) {
      expect(r.maxBodyBytes, `${r.method} ${r.path}`).toBe(4 * 1024);
    }
  });

  it('descargar es un permiso APARTE de ver y de generar', () => {
    const reglas = buildGatewayConfig().routes.filter((r) => r.service === 'reporting-service');
    const permisos = (p: string) => reglas.filter((r) => r.permission === p).map((r) => `${r.method} ${r.path}`);
    expect(permisos('tax_annex:export')).toEqual(['GET /reporting/annexes/runs/:id/export']);
    expect(permisos('tax_annex:generate').sort()).toEqual(['POST /reporting/annexes/:annex/:period/generate', 'PUT /reporting/annexes/:annex/:period/manual-inputs/:fieldCode']);
  });

  it('`/runs/:id/export` va antes que `/runs/:id`', () => {
    const reglas = buildGatewayConfig().routes.filter((r) => r.service === 'reporting-service');
    expect(reglas.findIndex((r) => r.path === '/reporting/annexes/runs/:id/export')).toBeLessThan(reglas.findIndex((r) => r.path === '/reporting/annexes/runs/:id'));
  });
});

describe('corte por plugin de /reporting/*', () => {
  it('con el plugin activo reenvía con el prefijo intacto y la organización', async () => {
    recibidas = [];
    permisosToken = ['*'];
    const app = gateway([PLUGIN]);
    for (const ruta of RUTAS) expect((await llamar(app, ruta)).status, `${ruta.method} ${ruta.path}`).toBe(200);
    expect(recibidas).toHaveLength(RUTAS.length);
    for (const r of recibidas) {
      expect(r.url?.startsWith('/reporting/')).toBe(true);
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
    const app = gateway([{ pluginCode: 'compliance.sri_annexes', status: 'inactive' }]);
    expect((await llamar(app, RUTAS[0]!)).status).toBe(403);
    expect(recibidas).toEqual([]);
  });
});

describe('permisos en el gateway', () => {
  it.each(RUTAS)('$method $path exige $permiso: sin él 403 y no llega al servicio; con él pasa', async (ruta) => {
    const app = gateway([PLUGIN]);
    recibidas = [];
    permisosToken = ['tax_annex:read', 'tax_annex:generate', 'tax_annex:export', 'invoice:read'].filter((p) => p !== ruta.permiso);
    expect((await llamar(app, ruta)).status).toBe(403);
    expect(recibidas).toEqual([]);

    permisosToken = [ruta.permiso];
    expect((await llamar(app, ruta)).status).toBe(200);
    expect(recibidas).toHaveLength(1);
  });

  it('un cliente que manda `X-Permissions: *` o el `X-Organization-Id` de otra organización no obtiene nada: valen los del token', async () => {
    const app = gateway([PLUGIN]);
    permisosToken = ['tax_annex:read'];
    recibidas = [];
    const falsas = { ...h, 'x-permissions': '*', 'x-organization-id': '3f1c8a20-0000-4000-8000-0000000000ff' };
    expect((await llamar(app, RUTAS[3]!, falsas)).status).toBe(403); // generar: el token no lo tiene
    expect((await llamar(app, RUTAS[0]!, falsas)).status).toBe(200);
    expect(recibidas).toHaveLength(1);
    expect(recibidas[0]!.org).toBe(ORG);
  });

  it('sin token → 401 y no llega nada al servicio', async () => {
    recibidas = [];
    const app = gateway([PLUGIN]);
    autenticado = false;
    expect((await llamar(app, RUTAS[0]!)).status).toBe(401);
    expect(recibidas).toEqual([]);
  });
});

describe('lo que NO está declarado no llega al servicio', () => {
  it('una ruta desconocida o un método no declarado responde 404 desde el gateway (con todos los permisos y el plugin activo)', async () => {
    recibidas = [];
    permisosToken = ['*'];
    const app = gateway([PLUGIN]);
    for (const [method, path] of [
      ['GET', '/reporting'],
      ['GET', '/reporting/otra-cosa'],
      ['GET', '/reporting/health'],
      ['DELETE', `/reporting/annexes/runs/${ID}`],
      ['PUT', `/reporting/annexes/runs/${ID}`],
      ['GET', '/reporting/annexes/f104/2026-10/generate'],
      ['POST', '/reporting/annexes/f104/2026-10/reconciliation'],
      ['DELETE', '/reporting/annexes/f104/2026-10/manual-inputs/ajustes'],
      ['POST', '/reporting/documents'],
    ] as const) {
      expect((await app.request(`http://gw${path}`, { method, headers: h }, env)).status, `${method} ${path}`).toBe(404);
    }
    expect(recibidas).toEqual([]);
  });

  it('un cuerpo grande en una ruta de escritura se rechaza antes de llegar al servicio', async () => {
    recibidas = [];
    permisosToken = ['*'];
    const app = gateway([PLUGIN]);
    const grande = JSON.stringify({ amountCents: 1, relleno: 'x'.repeat(8 * 1024) });
    const res = await app.request('http://gw/reporting/annexes/f104/2026-10/manual-inputs/ajustes', { method: 'PUT', headers: { ...h, 'content-length': String(grande.length) }, body: grande }, env);
    expect(res.status).toBe(413);
    expect(recibidas).toEqual([]);
  });
});
