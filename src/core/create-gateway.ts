import { Hono } from 'hono';
import { cors } from 'hono/cors';
import type { GatewayConfig, RouteRule } from './types';
import { buildContextHeaders, deriveSpoofHeaders } from './context';
import { proxyRequest } from './proxy';
import { errorBody } from './errors';
import { InMemoryRateLimitStore } from './rate-limit';

export function createGateway(config: GatewayConfig): Hono {
  const app = new Hono();
  const spoofHeaders = deriveSpoofHeaders(config.claimHeaders);
  const rateLimitStore = config.rateLimit?.store ?? new InMemoryRateLimitStore();
  const requestIdHeader = config.requestIdHeader ?? 'X-Request-Id';

  // ── Request-ID ──
  app.use('*', async (c, next) => {
    (c as any).set('requestId', c.req.header(requestIdHeader) ?? crypto.randomUUID());
    await next();
  });

  // ── CORS ──
  if (config.cors) {
    app.use('*', cors({ origin: config.cors.origin }));
  }

  // ── Rate limit ──
  if (config.rateLimit) {
    app.use('*', async (c, next) => {
      const ip =
        c.req.header('x-forwarded-for') ??
        c.req.header('cf-connecting-ip') ??
        'unknown';

      const { count, resetAt } = await rateLimitStore.hit(ip, config.rateLimit!.windowMs);

      if (count > config.rateLimit!.max) {
        const retryAfter = Math.ceil((resetAt - Date.now()) / 1000);
        return c.json(
          errorBody('RATE_LIMIT_EXCEEDED', 'Demasiadas peticiones. Intente de nuevo más tarde.'),
          429,
          { 'Retry-After': String(retryAfter) },
        );
      }

      await next();

      c.res.headers.set('X-RateLimit-Limit', String(config.rateLimit!.max));
      c.res.headers.set('X-RateLimit-Remaining', String(Math.max(0, config.rateLimit!.max - count)));
    });
  }

  // ── Health ──
  app.get('/health', (c) => c.json({ status: 'ok' }));

  // ── Rutas dinámicas ──
  for (const rule of config.routes) {
    const handler = createRouteHandler(rule, config, spoofHeaders);
    if (rule.method === 'ANY') {
      app.all(rule.path, handler);
    } else {
      app.on(rule.method as any, rule.path, handler);
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
) {
  return async (c: any) => {
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
