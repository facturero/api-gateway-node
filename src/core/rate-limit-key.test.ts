import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createGateway } from './create-gateway';
import type { GatewayConfig } from './types';

// Quién gasta el cupo del límite global y qué IP se le atribuye a cada petición. Un servicio local anota lo que le llega
// (en particular `X-Client-Ip`, que es lo que la bitácora guarda).
let servicio: Server;
let servicioUrl = '';
let clientIps: Array<string | undefined> = [];

beforeAll(async () => {
  servicio = createServer((req, res) => {
    clientIps.push(req.headers['x-client-ip'] as string | undefined);
    res.writeHead(200, { 'content-type': 'application/json' }).end('{}');
  });
  await new Promise<void>((ok) => servicio.listen(0, '127.0.0.1', ok));
  servicioUrl = `http://127.0.0.1:${(servicio.address() as AddressInfo).port}`;
});

afterAll(() => servicio.close());

/** Tokens de mentira: «Bearer user-X» verifica como el usuario X; cualquier otro no verifica. Cuenta cuántas veces se verificó. */
function gateway(max = 2) {
  const verificaciones = { n: 0 };
  const config: GatewayConfig = {
    authenticator: {
      authenticate: async (getHeader) => {
        verificaciones.n += 1;
        const token = getHeader('authorization')?.replace(/^Bearer /, '') ?? '';
        return token.startsWith('user-') ? { authenticated: true, claims: { sub: token.slice(5) } } : { authenticated: false, error: 'no' };
      },
    },
    claimHeaders: [{ claim: 'sub', header: 'X-User-Id' }],
    services: [{ name: 'svc', url: servicioUrl }],
    routes: [
      { method: 'GET', path: '/things/*', service: 'svc', stripPrefix: '' },
      { method: 'GET', path: '/public/*', service: 'svc', stripPrefix: '', public: true },
    ],
    rateLimit: { windowMs: 60_000, max },
  };
  return { app: createGateway(config), verificaciones };
}

// Todas desde la misma IP de socket, como una oficina detrás de un router.
const env = { incoming: { socket: { remoteAddress: '203.0.113.7', remotePort: 5000, remoteFamily: 'IPv4' } } };
const get = (app: ReturnType<typeof createGateway>, path: string, headers: Record<string, string> = {}) =>
  app.request(path, { method: 'GET', headers }, env);

describe('límite global: por usuario con sesión, por IP sin ella', () => {
  it('dos personas de la misma oficina (misma IP, cuentas distintas) tienen cada una su cupo', async () => {
    const { app } = gateway(2);
    const ana = { authorization: 'Bearer user-ana' };
    const beto = { authorization: 'Bearer user-beto' };
    expect((await get(app, '/things/1', ana)).status).toBe(200);
    expect((await get(app, '/things/1', ana)).status).toBe(200);
    expect((await get(app, '/things/1', ana)).status).toBe(429);
    // Ana agotó el suyo; Beto, desde la misma IP, sigue entrando.
    expect((await get(app, '/things/1', beto)).status).toBe(200);
    expect((await get(app, '/things/1', beto)).status).toBe(200);
  });

  it('un token inválido cuenta por IP: inventar tokens no abre un cupo nuevo en cada petición', async () => {
    const { app } = gateway(2);
    expect((await get(app, '/public/1', { authorization: 'Bearer basura-1' })).status).toBe(200);
    expect((await get(app, '/public/1', { authorization: 'Bearer basura-2' })).status).toBe(200);
    expect((await get(app, '/public/1', { authorization: 'Bearer basura-3' })).status).toBe(429);
  });

  it('el token se verifica una sola vez por petición (el límite y la ruta comparten el resultado)', async () => {
    const { app, verificaciones } = gateway(10);
    await get(app, '/things/1', { authorization: 'Bearer user-ana' });
    expect(verificaciones.n).toBe(1);
  });
});

// Desde un proxy nuestro (red de pods de k3s, como Traefik o cloudflared).
const viaProxy = { incoming: { socket: { remoteAddress: '10.42.0.5', remotePort: 5000, remoteFamily: 'IPv4' } } };
const getVia = (app: ReturnType<typeof createGateway>, path: string, headers: Record<string, string>, from = viaProxy) =>
  app.request(path, { method: 'GET', headers }, from);

describe('IP de la petición', () => {
  it('desde un cliente directo, x-forwarded-for se ignora: inventar una IP en cada petición no abre cupo nuevo', async () => {
    const { app } = gateway(2);
    expect((await getVia(app, '/public/1', { 'x-forwarded-for': '1.1.1.1' }, env)).status).toBe(200);
    expect((await getVia(app, '/public/1', { 'x-forwarded-for': '2.2.2.2' }, env)).status).toBe(200);
    expect((await getVia(app, '/public/1', { 'x-forwarded-for': '3.3.3.3' }, env)).status).toBe(429);
  });

  it('desde nuestro proxy cuenta la última entrada de x-forwarded-for (la que añadió él), no la primera', async () => {
    const { app } = gateway(2);
    const via = (spoof: string) => ({ 'x-forwarded-for': `${spoof}, 198.51.100.20` });
    expect((await getVia(app, '/public/1', via('1.1.1.1'))).status).toBe(200);
    expect((await getVia(app, '/public/1', via('2.2.2.2'))).status).toBe(200);
    expect((await getVia(app, '/public/1', via('3.3.3.3'))).status).toBe(429);
  });

  it('detrás de Cloudflare manda cf-connecting-ip, y es la que llega al servicio como X-Client-Ip', async () => {
    const { app } = gateway(10);
    clientIps = [];
    await getVia(app, '/public/1', { 'cf-connecting-ip': '190.15.0.9', 'x-forwarded-for': '6.6.6.6, 10.42.0.5' });
    expect(clientIps).toEqual(['190.15.0.9']);
  });

  it('un cf-connecting-ip que no viene de nuestro proxy no se cree: llega la IP del socket', async () => {
    const { app } = gateway(10);
    clientIps = [];
    await getVia(app, '/public/1', { 'cf-connecting-ip': '190.15.0.9' }, env);
    expect(clientIps).toEqual(['203.0.113.7']);
  });

  it('sin proxy delante, la IP del socket', async () => {
    const { app } = gateway(10);
    clientIps = [];
    await get(app, '/public/1');
    expect(clientIps).toEqual(['203.0.113.7']);
  });
});
