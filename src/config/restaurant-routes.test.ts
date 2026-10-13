import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { generateKeyPairSync } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildGatewayConfig } from './gateway.config';
import { createGateway } from '../core/create-gateway';
import type { GatewayConfig } from '../core/types';

// Ruta /restaurant/* (módulo de pago `restaurant.floorplan`): el gateway corta el HTTP, no el evento — ver el comentario
// en gateway.config.ts. Aquí se prueba la regla REAL que arma `gateway.config.ts` (no una copia) contra un
// restaurant-service y un plugin-catalog-service locales: que el corte por plugin responda 403 y que, con el plugin
// activo, el reenvío llegue al servicio con el prefijo `/restaurant` intacto.

const ORG = '3f1c8a20-0000-4000-8000-000000000001';
const ACTIVO = { pluginCode: 'restaurant.floorplan', status: 'active' };

let restaurant: Server;
let catalogo: Server;
let restaurantUrl = '';
let catalogoUrl = '';

// Lo que el gateway ve como plugins activos de la organización. Cada test lo fija antes de construir su gateway.
let filasCatalogo: Array<{ pluginCode: string; status: string }> = [];
// Lo que llegó de verdad al restaurant-service, en orden.
let recibidas: Array<{ method?: string; url?: string; org?: string }> = [];
// Organización que el gateway consultó al catálogo.
let orgsConsultadas: Array<string | undefined> = [];

beforeAll(async () => {
  const { publicKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });

  restaurant = createServer((req, res) => {
    recibidas.push({ method: req.method, url: req.url, org: req.headers['x-organization-id'] as string | undefined });
    req.resume(); // drena el cuerpo para no dejar el socket a medias
    res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}');
  });
  await new Promise<void>((ok) => restaurant.listen(0, '127.0.0.1', ok));
  restaurantUrl = `http://127.0.0.1:${(restaurant.address() as AddressInfo).port}`;

  catalogo = createServer((req, res) => {
    orgsConsultadas.push(req.headers['x-organization-id'] as string | undefined);
    req.resume();
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(filasCatalogo));
  });
  await new Promise<void>((ok) => catalogo.listen(0, '127.0.0.1', ok));
  catalogoUrl = `http://127.0.0.1:${(catalogo.address() as AddressInfo).port}`;

  process.env.JWT_PUBLIC_KEY = publicKey;
  process.env.JWT_ISSUER = 'test';
  process.env.JWT_AUDIENCE = 'test';
  process.env.AUTH_SERVICE_URL = 'http://auth.invalid:3000';
  process.env.RESTAURANT_SERVICE_URL = restaurantUrl;
  process.env.PLUGIN_CATALOG_SERVICE_URL = catalogoUrl;
});

afterAll(() => {
  restaurant.close();
  catalogo.close();
});

// El gateway real autentica con JWT; aquí solo importa el claim con la organización (el corte por plugin va después
// de autenticar y lee `org_id`). Los `permissions` con comodín dejan pasar el enforcement grueso de la ruta.
const autenticador: GatewayConfig['authenticator'] = {
  authenticate: async () => ({
    authenticated: true,
    claims: { sub: 'user-1', email: 'a@b.c', org_id: ORG, permissions: ['*'] },
  }),
};

// getConnInfo lee el socket del entorno de Node; aquí se simula.
const env = { incoming: { socket: { remoteAddress: '203.0.113.7', remotePort: 5000, remoteFamily: 'IPv4' } } };

/** Gateway con la configuración real de `gateway.config.ts`, salvo el autenticador y el catálogo bajo control del test. */
function gateway(over: { plugins?: Array<{ pluginCode: string; status: string }> } = {}) {
  filasCatalogo = over.plugins ?? [];
  const base = buildGatewayConfig();
  return createGateway({
    ...base,
    authenticator: autenticador,
    // Límite global holgado: los tests hacen varias peticiones y no buscamos un 429 por ruido.
    rateLimit: { ...base.rateLimit!, max: 10_000 },
  });
}

describe('declaración de la ruta /restaurant/* en el gateway', () => {
  it('no quita el prefijo y exige el plugin restaurant.floorplan', () => {
    const config = buildGatewayConfig();
    expect(config.routes.find((r) => r.path === '/restaurant/*')).toMatchObject({
      method: 'ANY',
      service: 'restaurant-service',
      stripPrefix: '',
      requiresPlugin: 'restaurant.floorplan',
    });
    expect(config.services.find((s) => s.name === 'restaurant-service')?.url).toBe(restaurantUrl);
  });

  it('el guardado del plano permite 512 KB y va ANTES del comodín (gana la primera regla que coincide)', () => {
    const config = buildGatewayConfig();
    const plan = config.routes.find((r) => r.path === '/restaurant/floors/:floorId/plan');
    expect(plan).toMatchObject({
      method: 'PUT',
      service: 'restaurant-service',
      stripPrefix: '',
      requiresPlugin: 'restaurant.floorplan',
      maxBodyBytes: 512 * 1024,
    });
    expect(config.routes.indexOf(plan!)).toBeLessThan(
      config.routes.findIndex((r) => r.path === '/restaurant/*'),
    );
  });

  it('sin RESTAURANT_SERVICE_URL el servicio no se registra (la ruta queda declarada, como /warehouses/*)', async () => {
    delete process.env.RESTAURANT_SERVICE_URL;
    vi.resetModules(); // loadEnv cachea el entorno la primera vez que se lee
    const { buildGatewayConfig: construir } = await import('./gateway.config.js');
    const sin = construir();
    expect(sin.services.find((s) => s.name === 'restaurant-service')).toBeUndefined();
    // La regla de ruta es estática (igual que /warehouses/*): sin el servicio
    // configurado el proxy responde 500 SERVICE_NOT_FOUND, no 404.
    expect(sin.routes.find((r) => r.path === '/restaurant/*')?.service).toBe('restaurant-service');
  });
});

describe('corte por plugin de /restaurant/*', () => {
  it('con el plugin activo reenvía al servicio con el prefijo /restaurant intacto', async () => {
    recibidas = [];
    const res = await gateway({ plugins: [ACTIVO] }).request(
      'http://gw/restaurant/establishments/e1/floors',
      { headers: { authorization: 'Bearer x' } },
      env,
    );
    expect(res.status).toBe(200);
    expect(recibidas).toEqual([
      { method: 'GET', url: '/restaurant/establishments/e1/floors', org: ORG },
    ]);
  });

  it('acepta el plano de ~200 KB y lo reenvía a PUT …/plan', async () => {
    recibidas = [];
    const plano = 'x'.repeat(200 * 1024);
    const res = await gateway({ plugins: [ACTIVO] }).request(
      'http://gw/restaurant/floors/f1/plan',
      {
        method: 'PUT',
        headers: { authorization: 'Bearer x', 'content-type': 'application/json' },
        body: plano,
      },
      env,
    );
    expect(res.status).toBe(200);
    expect(recibidas).toEqual([{ method: 'PUT', url: '/restaurant/floors/f1/plan', org: ORG }]);
  });

  it('sin el plugin responde 403 PLUGIN_NOT_ACTIVE consultando la organización del token, y no llega al servicio', async () => {
    recibidas = [];
    orgsConsultadas = [];
    const res = await gateway({ plugins: [] }).request(
      'http://gw/restaurant/establishments/e1/floors',
      { headers: { authorization: 'Bearer x' } },
      env,
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: 'PLUGIN_NOT_ACTIVE' });
    expect(orgsConsultadas).toEqual([ORG]);
    expect(recibidas).toEqual([]);
  });

  it('corta también el plano, las mesas y los horarios', async () => {
    recibidas = [];
    const app = gateway({ plugins: [] });
    const h = { authorization: 'Bearer x', 'content-type': 'application/json' };
    const estados = [
      (await app.request('http://gw/restaurant/floors/f1/plan', { method: 'PUT', headers: h, body: '{}' }, env)).status,
      (await app.request('http://gw/restaurant/tables/t1', { method: 'PATCH', headers: h, body: '{}' }, env)).status,
      (await app.request('http://gw/restaurant/establishments/e1/schedule/preview?date=2026-10-20', {}, env)).status,
    ];
    expect(estados).toEqual([403, 403, 403]);
    expect(recibidas).toEqual([]);
  });

  it('un plano de más de 512 KB responde 413 y no llega al servicio', async () => {
    recibidas = [];
    const res = await gateway({ plugins: [ACTIVO] }).request(
      'http://gw/restaurant/floors/f1/plan',
      {
        method: 'PUT',
        headers: { authorization: 'Bearer x', 'content-type': 'application/json' },
        body: 'x'.repeat(512 * 1024 + 1),
      },
      env,
    );
    expect(res.status).toBe(413);
    expect(recibidas).toEqual([]);
  });
});
