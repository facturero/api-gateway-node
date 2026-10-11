import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createGateway } from './create-gateway';
import type { GatewayConfig } from './types';

// Ruta de telemetría del navegador: pública, y por eso acotada. Lo que se prueba es el motor del gateway con la misma forma de
// regla que usa gateway.config.ts, contra un "colector" local que anota lo que le llega.
let colector: Server;
let recibido: Array<{ method?: string; url?: string; type?: string; bytes: number }> = [];
let colectorUrl = '';

beforeAll(async () => {
  colector = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      recibido.push({ method: req.method, url: req.url, type: req.headers['content-type'], bytes: Buffer.concat(chunks).length });
      res.writeHead(200, { 'content-type': 'application/json' }).end('{}');
    });
  });
  await new Promise<void>((ok) => colector.listen(0, '127.0.0.1', ok));
  colectorUrl = `http://127.0.0.1:${(colector.address() as AddressInfo).port}`;
});

afterAll(() => colector.close());

function gateway(over: { routeMax?: number; globalMax?: number; maxBodyBytes?: number } = {}) {
  const config: GatewayConfig = {
    authenticator: { authenticate: async () => ({ authenticated: false }) },
    claimHeaders: [],
    services: [{ name: 'otel-collector', url: colectorUrl }],
    routes: [
      {
        method: 'POST',
        path: '/telemetry/v1/traces',
        service: 'otel-collector',
        stripPrefix: '/telemetry',
        public: true,
        rateLimit: { windowMs: 60_000, max: over.routeMax ?? 60 },
        maxBodyBytes: over.maxBodyBytes ?? 1024,
      },
    ],
    cors: { origin: ['https://crm.example.com'], allowHeaders: ['traceparent', 'tracestate'] },
    rateLimit: { windowMs: 60_000, max: over.globalMax ?? 2, skipPaths: ['/telemetry/'] },
  };
  return createGateway(config);
}

// getConnInfo lee el socket del entorno de Node; aquí se simula.
const env = { incoming: { socket: { remoteAddress: '203.0.113.7', remotePort: 5000, remoteFamily: 'IPv4' } } };
const post = (app: ReturnType<typeof gateway>, body: string, path = '/telemetry/v1/traces') =>
  app.request(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body }, env);

describe('POST /telemetry/v1/traces', () => {
  it('es pública y reenvía al colector sin el prefijo /telemetry', async () => {
    recibido = [];
    const res = await post(gateway(), '{"resourceSpans":[]}');
    expect(res.status).toBe(200);
    expect(recibido).toEqual([{ method: 'POST', url: '/v1/traces', type: 'application/json', bytes: 20 }]);
  });

  it('un cuerpo mayor al tope responde 413 y no llega al colector', async () => {
    recibido = [];
    const res = await post(gateway({ maxBodyBytes: 100 }), 'x'.repeat(500));
    expect(res.status).toBe(413);
    expect(recibido).toEqual([]);
  });

  it('solo expone ese endpoint: ningún otro camino del colector ni otro método sale por aquí', async () => {
    recibido = [];
    const app = gateway();
    expect((await post(app, '{}', '/telemetry/v1/metrics')).status).toBe(404);
    expect((await post(app, '{}', '/telemetry/')).status).toBe(404);
    expect((await app.request('/telemetry/v1/traces', { method: 'GET' }, env)).status).toBe(404);
    expect(recibido).toEqual([]);
  });

  it('tiene su propio límite por IP: pasado el tope responde 429', async () => {
    const app = gateway({ routeMax: 3 });
    const estados: number[] = [];
    for (let i = 0; i < 5; i++) estados.push((await post(app, '{}')).status);
    expect(estados).toEqual([200, 200, 200, 429, 429]);
  });

  it('NO gasta el límite global: la telemetría no deja sin cupo al resto de las acciones del usuario', async () => {
    const app = gateway({ globalMax: 2 });
    for (let i = 0; i < 6; i++) expect((await post(app, '{}')).status).toBe(200);
    // Con el global en 2, tres telemetrías ya lo habrían agotado si contaran.
    expect((await app.request('/health', {}, env)).status).toBe(200);
  });
});

describe('CORS del navegador con trazas', () => {
  it('el preflight acepta traceparent (sin esto TODA llamada de la app fallaría al activarse la telemetría)', async () => {
    const res = await gateway().request(
      '/telemetry/v1/traces',
      {
        method: 'OPTIONS',
        headers: {
          origin: 'https://crm.example.com',
          'access-control-request-method': 'POST',
          'access-control-request-headers': 'content-type,traceparent',
        },
      },
      env,
    );
    expect(res.headers.get('access-control-allow-headers')?.toLowerCase()).toContain('traceparent');
  });
});
