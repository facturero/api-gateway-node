import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { bodyLimit } from 'hono/body-limit';
import { getConnInfo } from '@hono/node-server/conninfo';
import { httpInstrumentationMiddleware } from '@hono/otel';
import type { AuthResult, GatewayConfig, RateLimitStore, RouteRule } from './types';
import { buildContextHeaders, deriveSpoofHeaders } from './context';
import { proxyRequest } from './proxy';
import { errorBody } from './errors';
import { InMemoryRateLimitStore } from './rate-limit';

/**
 * Por defecto, cualquier conexión desde una red privada. En producción el túnel llega así: cloudflared (servicio del host) →
 * proxy TCP en 127.0.0.1:8080 → NodePort → pod, y el pod ve la IP del nodo o la de la red de k3s, ambas privadas. Desde internet
 * nadie llega con una IP privada (todo entra por el túnel), así que no se puede falsear `cf-connecting-ip` desde fuera. Lo que
 * queda: alguien en la red local podría inventarse su IP. Con `TRUSTED_PROXIES` se acota a la IP exacta del proxy.
 */
const DEFAULT_TRUSTED_PROXIES = ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '127.0.0.1'];

function trustedProxiesFrom(config: GatewayConfig): string[] {
  if (config.trustedProxies) return config.trustedProxies;
  const fromEnv = process.env.TRUSTED_PROXIES?.split(',').map((s) => s.trim()).filter(Boolean);
  return fromEnv?.length ? fromEnv : DEFAULT_TRUSTED_PROXIES;
}

/**
 * La IP de quien hace la petición, para el límite por IP y para `X-Client-Ip` (la bitácora la guarda).
 *
 * Las cabeceras de IP solo valen si quien conecta es un proxy nuestro (`trustedProxies`): cualquiera puede escribirlas, y antes el
 * gateway leía la primera de `x-forwarded-for` venga de donde viniera. Mandando una distinta en cada petición se saltaba el límite
 * por completo y quedaba una IP falsa en la bitácora (medido el 2026-11-09 en local). Desde un proxy nuestro, en este orden:
 *
 * 1. `cf-connecting-ip`: la pone el borde de Cloudflare y sobrescribe la que mande el cliente.
 * 2. La ÚLTIMA entrada de `x-forwarded-for`: cada proxy añade al final la IP que ve, y la de más a la derecha la añadió el nuestro
 *    (Traefik). Las de la izquierda las escribe el cliente.
 *
 * Si no, o si no vienen, la IP del socket. Sin este último paso todo caía en el literal 'unknown': un único bucket compartido por
 * todo el tráfico y nunca comparable con una IP/CIDR de confianza.
 */
export function clientIp(c: any, trustedProxies: string[] = DEFAULT_TRUSTED_PROXIES): string {
  // Node reporta conexiones IPv4 sobre un socket dual-stack como IPv4 mapeada a IPv6 (::ffff:172.18.0.1) — sin desmapear,
  // ipToNumber() (que espera un dotted-quad puro) la rechaza y nunca matchea CIDR.
  const socketIp = getConnInfo(c).remote.address?.replace(/^::ffff:/, '') ?? 'unknown';
  if (!isIpTrusted(socketIp, trustedProxies)) return socketIp;
  const cloudflare = c.req.header('cf-connecting-ip')?.trim();
  if (cloudflare) return cloudflare;
  const lastHop = c.req.header('x-forwarded-for')?.split(',').map((s: string) => s.trim()).filter(Boolean).pop();
  return lastHop || socketIp;
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
  const proxies = trustedProxiesFrom(config);
  const ipOf = (c: any) => clientIp(c, proxies);

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
      allowHeaders: ['Content-Type', 'Authorization', ...(config.cors.allowHeaders ?? [])],
      credentials: true,
    }));
  }

  // ── Rate limit ──
  // Con sesión válida, el cupo es POR USUARIO (`sub` del token); sin sesión, o con un token que no verifica, por IP. Por IP a
  // secas, todas las personas de una oficina (cada una con su cuenta, pero detrás del mismo router y la misma IP pública)
  // compartían un único cupo de RATE_LIMIT_MAX y recibían 429 a la vez. Un token inválido cuenta por IP para que inventar tokens
  // no abra un cupo nuevo en cada petición. El token se verifica aquí una sola vez y la ruta reutiliza el resultado.
  if (config.rateLimit) {
    app.use('*', async (c, next) => {
      if (config.rateLimit!.skipPaths?.some((prefix) => c.req.path.startsWith(prefix))) return next();
      const ip = ipOf(c);
      const effectiveTrustedIps = config.rateLimit!.trustedIpCache?.getTrustedIps() ?? config.rateLimit!.trustedIps ?? [];
      const isTrusted = isIpTrusted(ip, effectiveTrustedIps);
      const max = isTrusted ? (config.rateLimit!.trustedMax ?? config.rateLimit!.max * 5) : config.rateLimit!.max;

      let key = `ip:${ip}`;
      if (c.req.header('authorization')) {
        const auth = await config.authenticator.authenticate((name: string) => c.req.header(name));
        (c as any).set('authResult', auth);
        const sub = auth.authenticated ? auth.claims?.sub : undefined;
        if (typeof sub === 'string' && sub) key = `user:${sub}`;
      }

      const { count, resetAt } = await rateLimitStore.hit(key, config.rateLimit!.windowMs);

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
    if (rule.maxBodyBytes) {
      app.use(rule.path, bodyLimit({
        maxSize: rule.maxBodyBytes,
        onError: (c) => c.json(errorBody('PAYLOAD_TOO_LARGE', 'El cuerpo de la petición es demasiado grande.'), 413),
      }));
    }
    const handler = createRouteHandler(rule, config, spoofHeaders, rateLimitStore, ipOf);
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
  ipOf: (c: any) => string,
) {
  return async (c: any) => {
    // ── Rate limit propio de la ruta (además del global) ──
    if (rule.rateLimit) {
      const key = `${rule.method}:${rule.path}:${ipOf(c)}`;
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
      // Si el límite global ya verificó el token en esta petición, se reutiliza: verificar un RS256 dos veces no aporta nada.
      const authResult: AuthResult =
        (c.get('authResult') as AuthResult | undefined) ??
        (await config.authenticator.authenticate((name: string) => c.req.header(name)));
      if (!authResult.authenticated) {
        return c.json(
          errorBody('UNAUTHORIZED', authResult.error ?? 'Token inválido o ausente'),
          401,
        );
      }
      claims = authResult.claims;
    }

    // ── Chequeo de token stale (BUG #9) ──
    // Solo para rutas autenticadas. El pv del claim debe coincidir con el pv
    // actual del usuario en auth-service; si no, el token quedó viejo (se
    // asignó/quitaron roles, se deshabilitó el usuario, etc.) y hay que
    // re-autenticar. Fail-open: si el chequeo no puede consultar auth-service,
    // se deja pasar (la caché de pv nunca rompe el API por una caída puntual).
    //
    // Segunda verificación (getPvFresh): la caché se puebla durante la misma
    // petición que puede subir el pv (complete-profile crea la organización y
    // hace bump). El token nuevo (pv fresco) llegaría enseguida y chocaría con
    // el pv cacheado (viejo) → falso TOKEN_STALE → logout. Antes de rechazar,
    // se reconfirma contra auth-service sin caché; solo se rechaza si el valor
    // fresco realmente no coincide.
    if (claims && config.permissionsCache) {
      const sub = claims?.sub as string | undefined;
      const pvClaim = claims?.pv as number | undefined;
      if (sub && typeof pvClaim === 'number') {
        try {
          const currentPv = await config.permissionsCache.getPv(sub);
          if (currentPv !== null && currentPv !== pvClaim) {
            const freshPv = await config.permissionsCache.getPvFresh(sub);
            if (freshPv !== null && freshPv !== pvClaim) {
              return c.json(
                errorBody('TOKEN_STALE', 'Los permisos o el estado de la sesión cambiaron. Inicie sesión de nuevo.'),
                401,
              );
            }
            // El pv cacheado era viejo pero el fresco coincide: token válido.
            // La caché ya quedó actualizada por getPvFresh.
          }
        } catch {
          // fail-open
        }
      }
    }

    // ── Gate por plugins ──
    // La ruta pertenece a un módulo vendible: la organización debe tenerlo
    // activo. Se evalúa después de autenticar, para no filtrar qué módulos
    // tiene contratada una organización a quien no ha iniciado sesión.
    if (rule.requiresPlugin && config.pluginGate) {
      const organizationId = claims?.[config.pluginGate.organizationClaim] as string | undefined;
      if (!organizationId) {
        return c.json(
          errorBody('ORG_CONTEXT_REQUIRED', 'El token no identifica una organización.'),
          403,
        );
      }
      try {
        const active = await config.pluginGate.cache.isActive(organizationId, rule.requiresPlugin);
        if (!active) {
          return c.json(
            errorBody(
              'PLUGIN_NOT_ACTIVE',
              `Este módulo no está activo para su organización. Actívelo en el catálogo de plugins.`,
            ),
            403,
          );
        }
      } catch {
        return c.json(
          errorBody(
            'PLUGIN_CHECK_UNAVAILABLE',
            'No se pudo verificar los módulos activos de la organización.',
          ),
          503,
        );
      }
    }

    // ── Gate por permisos ──
    // Enforcement grueso: el claim `permissions` del token debe traer el
    // permiso de la ruta (o el comodín '*'). El servicio downstream hace el
    // enforcement fino releyendo X-Permissions. Se evalúa después de autenticar
    // para no filtrar la existencia de la ruta a quien no ha iniciado sesión.
    if (rule.permission) {
      const perms = claims?.permissions;
      const hasPermission = Array.isArray(perms)
        ? (perms as unknown[]).some((p) => p === rule.permission || p === '*')
        : false;
      if (!hasPermission) {
        return c.json(
          errorBody('PERMISSION_DENIED', `Permiso requerido: ${rule.permission}`),
          403,
        );
      }
    }

    const contextHeaders = buildContextHeaders(claims, config.claimHeaders);
    // La IP del cliente no es un claim del token: solo el gateway puede
    // afirmarla (mismo criterio que usa el rate-limit). Los servicios la
    // necesitan para que la bitácora de auditoría registre desde dónde se
    // hizo cada acción. Va después de borrar los headers spoofeables, así que
    // lo que mande el cliente en X-Client-Ip se descarta.
    contextHeaders['X-Client-Ip'] = ipOf(c);
    const requestId = (c as any).get('requestId') as string;

    return proxyRequest(c, rule, config.services, contextHeaders, spoofHeaders, requestId);
  };
}
