import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { httpInstrumentationMiddleware } from '@hono/otel';
import type { GatewayConfig, RateLimitStore, RouteRule } from './types';
import { buildContextHeaders, deriveSpoofHeaders } from './context';
import { proxyRequest } from './proxy';
import { errorBody } from './errors';
import { InMemoryRateLimitStore } from './rate-limit';

function clientIp(c: any): string {
  return (
    c.req.header('x-forwarded-for') ??
    c.req.header('cf-connecting-ip') ??
    'unknown'
  );
}

function ipToNumber(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let num = 0;
  for (const p of parts) {
    const n = parseInt(p, 10);
    if (isNaN(n) || n < 0 || n > 255) return null;
    num = (num << 8) + n;
  }
  return num >>> 0;
}

function isIpTrusted(ip: string, trustedIps: string[]): boolean {
  if (trustedIps.includes(ip)) return true;
  const ipNum = ipToNumber(ip);
  if (ipNum === null) return false;
  for (const entry of trustedIps) {
    if (entry.includes('/')) {
      const [cidr, bits] = entry.split('/');
      const cidrNum = ipToNumber(cidr);
      const mask = ~((1 << (32 - Number(bits))) - 1) >>> 0;
      if (cidrNum !== null && (ipNum & mask) === (cidrNum & mask)) return true;
    }
  }
  return false;
}

export function createGateway(config: GatewayConfig): Hono {
  const app = new Hono();
  const spoofHeaders = deriveSpoofHeaders(config.claimHeaders);
  const rateLimitStore = config.rateLimit?.store ?? new InMemoryRateLimitStore();
  const requestIdHeader = config.requestIdHeader ?? 'X-Request-Id';

  // ── OTel ──
  if (process.env.OTEL_EXPORTER_OTLP_ENDPOINT) {
    app.use('*', httpInstrumentationMiddleware({
      serviceName: process.env.OTEL_SERVICE_NAME ?? 'api-gateway',
      captureRequestHeaders: ['x-request-id'],
      spanNameFactory: (c) => `HTTP ${c.req.method} ${c.req.path}`,
    }));
  }

  // ── Request-ID ──
  app.use('*', async (c, next) => {
    (c as any).set('requestId', c.req.header(requestIdHeader) ?? crypto.randomUUID());
    await next();
  });

  // ── CORS ──
  if (config.cors) {
    app.use('*', cors({
      origin: config.cors.origin,
      allowMethods: ['GET', 'HEAD', 'PUT', 'POST', 'DELETE', 'PATCH', 'OPTIONS'],
      allowHeaders: ['Content-Type', 'Authorization'],
      credentials: true,
    }));
  }

  // ── Rate limit ──
  if (config.rateLimit) {
    app.use('*', async (c, next) => {
      const ip = clientIp(c);
      const effectiveTrustedIps = config.rateLimit!.trustedIpCache?.getTrustedIps() ?? config.rateLimit!.trustedIps ?? [];
      const isTrusted = isIpTrusted(ip, effectiveTrustedIps);
      const max = isTrusted ? (config.rateLimit!.trustedMax ?? config.rateLimit!.max * 5) : config.rateLimit!.max;

      const { count, resetAt } = await rateLimitStore.hit(ip, config.rateLimit!.windowMs);

      if (count > max) {
        const retryAfter = Math.ceil((resetAt - Date.now()) / 1000);
        return c.json(
          errorBody('RATE_LIMIT_EXCEEDED', 'Demasiadas peticiones. Intente de nuevo más tarde.'),
          429,
          { 'Retry-After': String(retryAfter) },
        );
      }

      await next();

      c.res.headers.set('X-RateLimit-Limit', String(max));
      c.res.headers.set('X-RateLimit-Remaining', String(Math.max(0, max - count)));
    });
  }

  // ── Health ──
  app.get('/health', (c) => c.json({ status: 'ok' }));

  // ── Rutas dinámicas ──
  for (const rule of config.routes) {
    const handler = createRouteHandler(rule, config, spoofHeaders, rateLimitStore);
    if (rule.method === 'ANY') {
      app.all(rule.path, handler);
    } else {
      app.on(rule.method as any, rule.path, handler);
    }
    if (rule.path.endsWith('/*')) {
      const exactPath = rule.path.slice(0, -2);
      if (rule.method === 'ANY') {
        app.all(exactPath, handler);
      } else {
        app.on(rule.method as any, exactPath, handler);
      }
    }
  }

  // ── 404 ──
  app.all('*', (c) => c.json(errorBody('NOT_FOUND', 'Ruta no encontrada'), 404));

  // ── Error handler ──
  app.onError((err, c) => {
    console.error('Gateway error:', err);
    return c.json(errorBody('INTERNAL_ERROR', 'Error interno del gateway'), 500);
  });

  return app;
}

function createRouteHandler(
  rule: RouteRule,
  config: GatewayConfig,
  spoofHeaders: string[],
  rateLimitStore: RateLimitStore,
) {
  return async (c: any) => {
    // ── Rate limit propio de la ruta (además del global) ──
    if (rule.rateLimit) {
      const key = `${rule.method}:${rule.path}:${clientIp(c)}`;
      const { count, resetAt } = await rateLimitStore.hit(key, rule.rateLimit.windowMs);

      if (count > rule.rateLimit.max) {
        const retryAfter = Math.ceil((resetAt - Date.now()) / 1000);
        return c.json(
          errorBody('RATE_LIMIT_EXCEEDED', 'Demasiadas peticiones. Intente de nuevo más tarde.'),
          429,
          { 'Retry-After': String(retryAfter) },
        );
      }
    }

    let claims: Record<string, unknown> | undefined;

    if (!rule.public) {
      const authResult = await config.authenticator.authenticate(
        (name: string) => c.req.header(name),
      );
      if (!authResult.authenticated) {
        return c.json(
          errorBody('UNAUTHORIZED', authResult.error ?? 'Token inválido o ausente'),
          401,
        );
      }
      claims = authResult.claims;
    }

    const contextHeaders = buildContextHeaders(claims, config.claimHeaders);
    const requestId = (c as any).get('requestId') as string;

    return proxyRequest(c, rule, config.services, contextHeaders, spoofHeaders, requestId);
  };
}
