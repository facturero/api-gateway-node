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

  return {
    authenticator,
    claimHeaders: [
      { claim: 'sub', header: 'X-User-Id' },
      { claim: 'email', header: 'X-User-Email' },
      { claim: 'org_id', header: 'X-Organization-Id' },
      { claim: 'country_code', header: 'X-Country-Code' },
    ],
    services: [{ name: 'auth-service', url: env.AUTH_SERVICE_URL }],
    routes: [
      { method: 'POST', path: '/auth/register', service: 'auth-service', public: true },
      { method: 'POST', path: '/auth/login', service: 'auth-service', public: true },
      { method: 'POST', path: '/auth/google', service: 'auth-service', public: true },
      { method: 'POST', path: '/auth/refresh', service: 'auth-service', public: true },
      { method: 'POST', path: '/auth/logout', service: 'auth-service', public: true },
      { method: 'ANY', path: '/auth/*', service: 'auth-service', public: false },
    ],
    cors: { origin: env.CORS_ORIGIN },
    rateLimit: {
      windowMs: env.RATE_LIMIT_WINDOW_MS,
      max: env.RATE_LIMIT_MAX,
    },
  };
}
