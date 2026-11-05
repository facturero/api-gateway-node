import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { generateKeyPairSync } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildGatewayConfig } from './gateway.config';
import { createGateway } from '../core/create-gateway';
import type { GatewayConfig } from '../core/types';

// Ruta /projects/* (Proyectos y tareas, módulo `projects.tasks_kanban`). Se prueba la regla REAL de `gateway.config.ts` contra un
// projects-service y un plugin-catalog-service locales: corte por módulo (403 PLUGIN_NOT_ACTIVE), corte por `project:read`
// (403 PERMISSION_DENIED) y, con ambos, reenvío con el prefijo `/projects` intacto (también `/projects` a secas y `my-tasks`).

const ORG = '3f1c8a20-0000-4000-8000-000000000002';
const ACTIVO = { pluginCode: 'projects.tasks_kanban', status: 'active' };

let projects: Server;
let catalogo: Server;
let filasCatalogo: Array<{ pluginCode: string; status: string }> = [];
let recibidas: Array<{ method?: string; url?: string; org?: string; perms?: string }> = [];

beforeAll(async () => {
  const { publicKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });

  projects = createServer((req, res) => {
    recibidas.push({
      method: req.method,
      url: req.url,
      org: req.headers['x-organization-id'] as string | undefined,
      perms: req.headers['x-permissions'] as string | undefined,
    });
    req.resume();
    res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}');
  });
  await new Promise<void>((ok) => projects.listen(0, '127.0.0.1', ok));

  catalogo = createServer((req, res) => {
    req.resume();
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(filasCatalogo));
  });
  await new Promise<void>((ok) => catalogo.listen(0, '127.0.0.1', ok));

  process.env.JWT_PUBLIC_KEY = publicKey;
  process.env.JWT_ISSUER = 'test';
  process.env.JWT_AUDIENCE = 'test';
  process.env.AUTH_SERVICE_URL = 'http://auth.invalid:3000';
  process.env.PROJECTS_SERVICE_URL = `http://127.0.0.1:${(projects.address() as AddressInfo).port}`;
  process.env.PLUGIN_CATALOG_SERVICE_URL = `http://127.0.0.1:${(catalogo.address() as AddressInfo).port}`;
});

afterAll(() => {
  projects.close();
  catalogo.close();
});

const env = { incoming: { socket: { remoteAddress: '203.0.113.7', remotePort: 5000, remoteFamily: 'IPv4' } } };

function gateway(opts: { plugins?: Array<{ pluginCode: string; status: string }>; permissions?: string[] } = {}) {
  filasCatalogo = opts.plugins ?? [];
  const autenticador: GatewayConfig['authenticator'] = {
    authenticate: async () => ({
      authenticated: true,
      claims: { sub: 'user-1', email: 'a@b.c', org_id: ORG, permissions: opts.permissions ?? ['project:read'] },
    }),
  };
  const base = buildGatewayConfig();
  return createGateway({ ...base, authenticator: autenticador, rateLimit: { ...base.rateLimit!, max: 10_000 } });
}

const get = (gw: ReturnType<typeof gateway>, path: string) => gw.request(`http://gw${path}`, { headers: { authorization: 'Bearer x' } }, env);

describe('ruta /projects/* en el gateway', () => {
  it('se declara con el módulo, el permiso de usar el módulo y sin quitar el prefijo', () => {
    const config = buildGatewayConfig();
    expect(config.routes.find((r) => r.path === '/projects/*')).toMatchObject({
      method: 'ANY',
      service: 'projects-service',
      stripPrefix: '',
      requiresPlugin: 'projects.tasks_kanban',
      permission: 'project:read',
    });
    expect(config.services.find((s) => s.name === 'projects-service')).toBeDefined();
  });

  it('sin el módulo activo: 403 y no llega al servicio', async () => {
    recibidas = [];
    const res = await get(gateway({ plugins: [] }), '/projects');
    expect(res.status).toBe(403);
    expect(recibidas).toEqual([]);
  });

  it('con el módulo pero sin `project:read`: 403 PERMISSION_DENIED', async () => {
    recibidas = [];
    const res = await get(gateway({ plugins: [ACTIVO], permissions: ['customer:read'] }), '/projects/my-tasks');
    expect(res.status).toBe(403);
    expect(((await res.json()) as { code: string }).code).toBe('PERMISSION_DENIED');
    expect(recibidas).toEqual([]);
  });

  it('con ambos reenvía con el prefijo intacto, `/projects` a secas incluido, y propaga organización y permisos', async () => {
    recibidas = [];
    const gw = gateway({ plugins: [ACTIVO], permissions: ['project:read', 'project:create'] });
    expect((await get(gw, '/projects')).status).toBe(200);
    expect((await get(gw, '/projects/my-tasks')).status).toBe(200);
    expect(recibidas.map((r) => r.url)).toEqual(['/projects', '/projects/my-tasks']);
    expect(recibidas[0]).toMatchObject({ org: ORG, perms: 'project:read,project:create' });
  });
});

describe('horas y carga de trabajo: módulos propios, antes del comodín', () => {
  it('/projects/time-entries exige `projects.time_tracking` aunque Proyectos esté activo', async () => {
    recibidas = [];
    const sinHoras = await get(gateway({ plugins: [ACTIVO] }), '/projects/time-entries');
    expect(sinHoras.status).toBe(403);
    expect(recibidas).toHaveLength(0);
    const conHoras = await get(gateway({ plugins: [ACTIVO, { pluginCode: 'projects.time_tracking', status: 'active' }] }), '/projects/time-entries/timer');
    expect(conHoras.status).toBe(200);
    expect(recibidas.at(-1)?.url).toBe('/projects/time-entries/timer');
  });

  it('/projects/workload exige `projects.resource_allocation`; el resto de /projects/* sigue con su regla', async () => {
    recibidas = [];
    expect((await get(gateway({ plugins: [ACTIVO] }), '/projects/workload?from=2026-11-02')).status).toBe(403);
    expect((await get(gateway({ plugins: [ACTIVO, { pluginCode: 'projects.resource_allocation', status: 'active' }] }), '/projects/workload?from=2026-11-02')).status).toBe(200);
    expect((await get(gateway({ plugins: [ACTIVO] }), '/projects/my-tasks')).status).toBe(200);
    const config = buildGatewayConfig();
    const orden = config.routes.map((r) => r.path);
    expect(orden.indexOf('/projects/time-entries/*')).toBeLessThan(orden.indexOf('/projects/*'));
    expect(orden.indexOf('/projects/workload')).toBeLessThan(orden.indexOf('/projects/*'));
  });
});

describe('facturar el proyecto: módulo y permiso propios', () => {
  const FACTURAR = { pluginCode: 'projects.project_billing', status: 'active' };
  it('/projects/billing/* exige `projects.project_billing` y `project:bill`', async () => {
    recibidas = [];
    const ruta = '/projects/billing/3f1c8a20-0000-4000-8000-0000000000aa';
    expect((await get(gateway({ plugins: [ACTIVO], permissions: ['project:read', 'project:bill'] }), ruta)).status).toBe(403);
    expect((await get(gateway({ plugins: [ACTIVO, FACTURAR], permissions: ['project:read'] }), ruta)).status).toBe(403);
    expect(recibidas).toHaveLength(0);
    expect((await get(gateway({ plugins: [ACTIVO, FACTURAR], permissions: ['project:read', 'project:bill'] }), ruta)).status).toBe(200);
    expect(recibidas.at(-1)?.url).toBe(ruta);
  });
});

