import type { Context } from 'hono';
import type { RouteRule, ServiceConfig } from './types';
import { errorBody } from './errors';

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

  let targetPath = c.req.path;
  if (rule.stripPrefix) {
    targetPath = targetPath.replace(rule.stripPrefix, '') || '/';
  }

  const targetUrl = new URL(targetPath, service.url).toString();

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

  const body = c.req.method !== 'GET' && c.req.method !== 'HEAD' ? c.req.raw.body : undefined;
  const downstreamReq = new Request(targetUrl, {
    method: c.req.method,
    headers: downstreamHeaders,
    body,
  });

  try {
    const response = await fetch(downstreamReq);
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: sanitizeResponseHeaders(response.headers),
    });
  } catch {
    return c.json(
      errorBody('DOWNSTREAM_ERROR', 'Error al conectar con el servicio downstream'),
      502,
    );
  }
}
