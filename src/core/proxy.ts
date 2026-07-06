import type { Context } from 'hono';
import type { RouteRule, ServiceConfig } from './types';
import { errorBody } from './errors';

// eslint-disable-next-line no-console
const log = console.error.bind(console, '[proxy]');

const HOP_BY_HOP_HEADERS = [
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailers',
  'transfer-encoding',
  'upgrade',
];

function sanitizeResponseHeaders(headers: Headers): Headers {
  const sanitized = new Headers();
  for (const [key, value] of headers) {
    if (!HOP_BY_HOP_HEADERS.includes(key.toLowerCase())) {
      sanitized.set(key, value);
    }
  }
  return sanitized;
}

export async function proxyRequest(
  c: Context,
  rule: RouteRule,
  services: ServiceConfig[],
  contextHeaders: Record<string, string>,
  spoofHeaders: string[],
  requestId: string,
): Promise<Response> {
  const service = services.find((s) => s.name === rule.service);
  if (!service) {
    return c.json(errorBody('SERVICE_NOT_FOUND', `Servicio '${rule.service}' no configurado`), 500);
  }

  const incomingUrl = new URL(c.req.url);
  let targetPath = incomingUrl.pathname;
  if (rule.stripPrefix) {
    targetPath = targetPath.replace(rule.stripPrefix, '') || '/';
  }

  // Preservar el query string al reenviar.
  const targetUrl = new URL(targetPath, service.url);
  targetUrl.search = incomingUrl.search;
  const targetUrlStr = targetUrl.toString();

  const downstreamHeaders = new Headers(c.req.raw.headers);

  for (const h of HOP_BY_HOP_HEADERS) {
    downstreamHeaders.delete(h);
  }

  for (const h of spoofHeaders) {
    downstreamHeaders.delete(h);
  }

  for (const [header, value] of Object.entries(contextHeaders)) {
    downstreamHeaders.set(header, value);
  }

  downstreamHeaders.set('X-Request-Id', requestId);

  // Reenviar el body como stream requiere duplex 'half' en undici (fetch de Node).
  const hasBody = c.req.method !== 'GET' && c.req.method !== 'HEAD';
  const body = hasBody ? c.req.raw.body : null;
  const init: RequestInit & { duplex?: 'half'; redirect?: 'manual' } = {
    method: c.req.method,
    headers: downstreamHeaders,
    redirect: 'manual',
  };
  if (body) {
    init.body = body;
    init.duplex = 'half';
    downstreamHeaders.delete('Content-Length');
  }

  // undici (Node.js fetch) no soporta ciertos headers del cliente original
  downstreamHeaders.delete('expect');

  const downstreamReq = new Request(targetUrlStr, init);

  try {
    const response = await fetch(downstreamReq);
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: sanitizeResponseHeaders(response.headers),
    });
  } catch (err) {
    log('Proxy error:', err);
    return c.json(
      errorBody('DOWNSTREAM_ERROR', 'Error al conectar con el servicio downstream'),
      502,
    );
  }
}
