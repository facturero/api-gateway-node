import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { generateKeyPairSync } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildGatewayConfig } from './gateway.config';
import { createGateway } from '../core/create-gateway';
import type { GatewayConfig } from '../core/types';

// Rutas de reservas del restaurante. Se prueba la configuración REAL de `gateway.config.ts` (no una copia) contra un
// restaurant-service y un plugin-catalog-service de mentira:
//  - las del personal cortan por `restaurant.reservations` (distinto del mapa) y van antes del comodín `/restaurant/*`;
//  - las del cliente final son públicas, con límite de ritmo por IP, y no dejan pasar cabeceras de contexto inventadas.

const ORG = '3f1c8a20-0000-4000-8000-000000000001';

let restaurant: Server;
let catalogo: Server;
let restaurantUrl = '';
let catalogoUrl = '';
let filasCatalogo: Array<{ pluginCode: string; status: string }> = [];
let recibidas: Array<{ method?: string; url?: string; org?: string; user?: string; perms?: string }> = [];

beforeAll(async () => {
  const { publicKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });

  restaurant = createServer((req, res) => {
    recibidas.push({
      method: req.method,
      url: req.url,
      org: req.headers['x-organization-id'] as string | undefined,
      user: req.headers['x-user-id'] as string | undefined,
      perms: req.headers['x-permissions'] as string | undefined,
    });
    req.resume();
    res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}');
  });
  await new Promise<void>((ok) => restaurant.listen(0, '127.0.0.1', ok));
  restaurantUrl = `http://127.0.0.1:${(restaurant.address() as AddressInfo).port}`;

  catalogo = createServer((req, res) => {
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

const autenticador: GatewayConfig['authenticator'] = {
  authenticate: async () => ({
    authenticated: true,
    claims: { sub: 'user-1', email: 'a@b.c', org_id: ORG, permissions: ['*'] },
  }),
};

const env = { incoming: { socket: { remoteAddress: '203.0.113.7', remotePort: 5000, remoteFamily: 'IPv4' } } };

function gateway(plugins: string[] = []) {
  filasCatalogo = plugins.map((pluginCode) => ({ pluginCode, status: 'active' }));
  const base = buildGatewayConfig();
  return createGateway({
    ...base,
    authenticator: autenticador,
    rateLimit: { ...base.rateLimit!, max: 10_000 },
  });
}

const staff = { authorization: 'Bearer x', 'content-type': 'application/json' };

describe('declaración de las rutas de reservas', () => {
  const config = () => buildGatewayConfig();

  it('las rutas del personal exigen restaurant.reservations y van antes del comodín del mapa', () => {
    const comodin = config().routes.findIndex((r) => r.path === '/restaurant/*');
    const rutas = [
      '/restaurant/reservations/*',
      '/restaurant/establishments/:establishmentId/reservations',
      '/restaurant/establishments/:establishmentId/reservation-settings',
      '/restaurant/establishments/:establishmentId/availability',
    ];
    for (const path of rutas) {
      const regla = config().routes.find((r) => r.path === path);
      expect(regla, path).toMatchObject({ service: 'restaurant-service', stripPrefix: '', requiresPlugin: 'restaurant.reservations' });
      expect(config().routes.indexOf(regla!), path).toBeLessThan(comodin);
    }
  });

  it('las rutas del cliente son públicas, con límite de ritmo, y NO piden plugin (lo resuelve el servicio)', () => {
    const publicas = config().routes.filter((r) => r.path.startsWith('/public/'));
    expect(publicas.map((r) => `${r.method} ${r.path}`)).toEqual([
      'GET /public/restaurants/:slug',
      'GET /public/restaurants/:slug/availability',
      'POST /public/restaurants/:slug/reservations',
      'GET /public/reservations/:token',
      'POST /public/reservations/:token/cancel',
    ]);
    for (const r of publicas) {
      expect(r.public, r.path).toBe(true);
      expect(r.rateLimit, r.path).toBeDefined();
      expect(r.requiresPlugin, r.path).toBeUndefined();
      expect(r.stripPrefix, r.path).toBe('');
    }
  });

  it('crear una reserva es lo más limitado: pocas por IP y cuerpo pequeño', () => {
    const crear = config().routes.find((r) => r.path === '/public/restaurants/:slug/reservations')!;
    expect(crear.rateLimit).toEqual({ windowMs: 10 * 60_000, max: 5 });
    expect(crear.maxBodyBytes).toBeLessThanOrEqual(8 * 1024);
  });
});

describe('corte por plugin de las rutas del personal', () => {
  const rutas: Array<[string, string, string]> = [
    ['GET', '/restaurant/establishments/e1/reservations?date=2026-10-17', 'lista del día'],
    ['POST', '/restaurant/establishments/e1/reservations', 'anotar reserva'],
    ['GET', '/restaurant/establishments/e1/reservation-settings', 'ajustes'],
    ['PUT', '/restaurant/establishments/e1/reservation-settings', 'guardar ajustes'],
    ['GET', '/restaurant/establishments/e1/availability?date=2026-10-17&partySize=2', 'disponibilidad'],
    ['GET', '/restaurant/reservations/r1', 'detalle'],
    ['PATCH', '/restaurant/reservations/r1/status', 'estado'],
    ['POST', '/restaurant/reservations/r1/cancel', 'cancelar'],
  ];

  it.each(rutas)('%s %s (%s): solo con el mapa activo NO pasa', async (method, path) => {
    recibidas = [];
    const res = await gateway(['restaurant.floorplan']).request(
      `http://gw${path}`,
      { method, headers: staff, body: method === 'GET' ? undefined : '{}' },
      env,
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: 'PLUGIN_NOT_ACTIVE' });
    expect(recibidas).toEqual([]);
  });

  it.each(rutas)('%s %s (%s): con las reservas activas llega al servicio con el prefijo intacto', async (method, path) => {
    recibidas = [];
    const res = await gateway(['restaurant.reservations']).request(
      `http://gw${path}`,
      { method, headers: staff, body: method === 'GET' ? undefined : '{}' },
      env,
    );
    expect(res.status).toBe(200);
    expect(recibidas).toEqual([expect.objectContaining({ method, url: path, org: ORG })]);
  });

  it('el mapa sigue cortándose por restaurant.floorplan, no por las reservas', async () => {
    recibidas = [];
    const solo = await gateway(['restaurant.reservations']).request('http://gw/restaurant/establishments/e1/floors', { headers: staff }, env);
    expect(solo.status).toBe(403);
    const con = await gateway(['restaurant.floorplan']).request('http://gw/restaurant/establishments/e1/floors', { headers: staff }, env);
    expect(con.status).toBe(200);
  });
});

describe('rutas públicas del cliente final', () => {
  const body = JSON.stringify({ date: '2026-10-17', time: '19:30', partySize: 2, guestName: 'Ana', guestEmail: 'a@b.c', guestPhone: '0991234567' });
  const post = { method: 'POST', headers: { 'content-type': 'application/json' }, body };

  it('responden sin iniciar sesión y reenvían la ruta intacta', async () => {
    recibidas = [];
    const app = gateway([]); // ningún plugin: el corte por módulo NO se hace aquí
    const h = await app.request('http://gw/public/restaurants/la-esquina', {}, env);
    const d = await app.request('http://gw/public/restaurants/la-esquina/availability?date=2026-10-17&partySize=2', {}, env);
    const r = await app.request('http://gw/public/restaurants/la-esquina/reservations', post, env);
    const g = await app.request('http://gw/public/reservations/tok123', {}, env);
    const c = await app.request('http://gw/public/reservations/tok123/cancel', { method: 'POST', headers: post.headers, body: '{}' }, env);
    expect([h.status, d.status, r.status, g.status, c.status]).toEqual([200, 200, 200, 200, 200]);
    expect(recibidas.map((x) => `${x.method} ${x.url}`)).toEqual([
      'GET /public/restaurants/la-esquina',
      'GET /public/restaurants/la-esquina/availability?date=2026-10-17&partySize=2',
      'POST /public/restaurants/la-esquina/reservations',
      'GET /public/reservations/tok123',
      'POST /public/reservations/tok123/cancel',
    ]);
  });

  it('no dejan pasar cabeceras de contexto inventadas por quien llama', async () => {
    recibidas = [];
    await gateway([]).request(
      'http://gw/public/restaurants/la-esquina',
      { headers: { 'x-organization-id': 'ORG-AJENA', 'x-user-id': 'admin', 'x-permissions': 'reservation:manage,*' } },
      env,
    );
    expect(recibidas).toHaveLength(1);
    expect(recibidas[0]).toMatchObject({ org: undefined, user: undefined, perms: undefined });
  });

  it('la sexta reserva desde la misma IP en 10 minutos recibe 429', async () => {
    recibidas = [];
    const app = gateway([]);
    const estados: number[] = [];
    for (let i = 0; i < 7; i += 1) estados.push((await app.request('http://gw/public/restaurants/la-esquina/reservations', post, env)).status);
    expect(estados).toEqual([200, 200, 200, 200, 200, 429, 429]);
    expect(recibidas).toHaveLength(5);
  });

  it('el límite es por IP: otra IP sigue pudiendo reservar', async () => {
    const app = gateway([]);
    for (let i = 0; i < 6; i += 1) await app.request('http://gw/public/restaurants/otra/reservations', post, env);
    const otra = { incoming: { socket: { remoteAddress: '198.51.100.9', remotePort: 5000, remoteFamily: 'IPv4' } } };
    expect((await app.request('http://gw/public/restaurants/otra/reservations', post, otra)).status).toBe(200);
  });

  it('un cuerpo enorme se corta con 413 sin llegar al servicio', async () => {
    recibidas = [];
    const res = await gateway([]).request(
      'http://gw/public/restaurants/la-esquina/reservations',
      { method: 'POST', headers: post.headers, body: JSON.stringify({ notes: 'x'.repeat(10_000) }) },
      env,
    );
    expect(res.status).toBe(413);
    expect(recibidas).toEqual([]);
  });
});
