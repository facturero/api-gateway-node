import { readFileSync } from 'node:fs';
import { loadEnv } from './env';
import { JwtAuthenticator } from '../core/authenticator';
import type { GatewayConfig } from '../core/types';

export function buildGatewayConfig(): GatewayConfig {
  const env = loadEnv();

  const publicKey =
    env.JWT_PUBLIC_KEY ?? readFileSync(env.JWT_PUBLIC_KEY_PATH, 'utf-8');

  const authenticator = new JwtAuthenticator({
    publicKey,
    issuer: env.JWT_ISSUER,
    audience: env.JWT_AUDIENCE,
  });

  const services: GatewayConfig['services'] = [{ name: 'auth-service', url: env.AUTH_SERVICE_URL }];

  if (env.ORG_SERVICE_URL) services.push({ name: 'org-service', url: env.ORG_SERVICE_URL });
  if (env.CUSTOMER_SERVICE_URL) services.push({ name: 'customer-service', url: env.CUSTOMER_SERVICE_URL });
  if (env.TAX_SERVICE_URL) services.push({ name: 'tax-service', url: env.TAX_SERVICE_URL });
  if (env.DOCUMENT_SERVICE_URL) services.push({ name: 'document-service', url: env.DOCUMENT_SERVICE_URL });

  return {
    authenticator,
    claimHeaders: [
      { claim: 'sub', header: 'X-User-Id' },
      { claim: 'email', header: 'X-User-Email' },
      { claim: 'org_id', header: 'X-Organization-Id' },
      { claim: 'country_code', header: 'X-Country-Code' },
    ],
    services,
    routes: [
      { method: 'POST', path: '/auth/register', service: 'auth-service', public: true },
      { method: 'POST', path: '/auth/login', service: 'auth-service', public: true },
      { method: 'POST', path: '/auth/google', service: 'auth-service', public: true },
      { method: 'POST', path: '/auth/refresh', service: 'auth-service', public: true },
      { method: 'POST', path: '/auth/logout', service: 'auth-service', public: true },
      { method: 'ANY', path: '/auth/*', service: 'auth-service', public: false },

      { method: 'ANY', path: '/organizations/*', service: 'org-service', stripPrefix: '' },
      { method: 'ANY', path: '/establishments/*', service: 'org-service', stripPrefix: '' },

      { method: 'ANY', path: '/customers/*', service: 'customer-service', stripPrefix: '' },
      { method: 'ANY', path: '/contacts/*', service: 'customer-service', stripPrefix: '' },
      { method: 'ANY', path: '/addresses/*', service: 'customer-service', stripPrefix: '' },
      { method: 'ANY', path: '/tags/*', service: 'customer-service', stripPrefix: '' },
      { method: 'ANY', path: '/identification-types/*', service: 'customer-service', stripPrefix: '' },

      { method: 'ANY', path: '/countries/*', service: 'tax-service', stripPrefix: '' },

      { method: 'ANY', path: '/files/*', service: 'document-service', stripPrefix: '' },
    ],
    cors: { origin: env.CORS_ORIGIN },
    rateLimit: {
      windowMs: env.RATE_LIMIT_WINDOW_MS,
      max: env.RATE_LIMIT_MAX,
    },
  };
}
