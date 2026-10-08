import { generateKeyPairSync } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { buildGatewayConfig } from './gateway.config';

// Cada ruta que un servicio expone y el gateway no declara es un 404 para el navegador (o cae al comodín de otro servicio):
// los endpoints de descuentos de plugin-catalog-service quedaron sin salida a internet por eso.
type Route = { method: string; path: string; service: string };
let rutas: Route[] = [];

beforeAll(() => {
  const { publicKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  process.env.JWT_PUBLIC_KEY = publicKey;
  process.env.JWT_ISSUER = 'test';
  process.env.JWT_AUDIENCE = 'test';
  process.env.AUTH_SERVICE_URL = 'http://auth:3000';
  process.env.ORG_SERVICE_URL = 'http://org:3002';
  process.env.PLUGIN_CATALOG_SERVICE_URL = 'http://plugins:3011';
  rutas = (buildGatewayConfig() as unknown as { routes: Route[] }).routes;
});

/** A qué servicio va una petición: la PRIMERA regla que coincide, como hace el gateway. */
function destino(method: string, path: string): string | undefined {
  const coincide = (r: Route) => {
    if (r.method !== 'ANY' && r.method !== method) return false;
    if (r.path.endsWith('/*')) return path.startsWith(r.path.slice(0, -1)) || path === r.path.slice(0, -2);
    return r.path === path;
  };
  return rutas.find(coincide)?.service;
}

describe('rutas de plugin-catalog-service en el gateway', () => {
  it.each([
    ['GET', '/organizations/me/plugins'],
    ['GET', '/organizations/me/plugins/pos.core/quote'],
    ['POST', '/organizations/me/plugins/pos.core/activate'],
    ['POST', '/organizations/me/plugins/pos.core/deactivate'],
    ['POST', '/organizations/me/plugins/pos.core/cancel-deactivation'],
    ['GET', '/organizations/me/subscription'],
    ['GET', '/organizations/me/discount-redemptions'],
    ['GET', '/admin/discounts'],
    ['POST', '/admin/discounts'],
    ['PATCH', '/admin/discounts/6f9619ff-8b86-4d11-b42d-00c04fc964ff'],
    ['POST', '/admin/discounts/6f9619ff-8b86-4d11-b42d-00c04fc964ff/deactivate'],
    ['POST', '/admin/plugin-requests/abc/fulfill'],
  ])('%s %s llega a plugin-catalog-service y no al comodín de organizaciones', (metodo, ruta) => {
    expect(destino(metodo, ruta)).toBe('plugin-catalog-service');
  });

  it('el comodín /organizations/* sigue mandando lo demás a organization-service', () => {
    expect(destino('GET', '/organizations/me')).toBe('org-service');
  });
});
