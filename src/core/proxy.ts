import type { Context } from 'hono';
import type { RouteRule, ServiceConfig } from './types';
import { errorBody } from './errors';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';

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

async function proxyRawS3(
  c: Context,
  rule: RouteRule,
  service: ServiceConfig,
  requestId: string,
): Promise<Response> {
  const incomingUrl = new URL(c.req.url);
  let targetPath = incomingUrl.pathname;
  if (rule.stripPrefix) {
    targetPath = targetPath.replace(rule.stripPrefix, '') || '/';
  }
  const targetUrl = new URL(targetPath, service.url);
  targetUrl.search = incomingUrl.search;

  const body = Buffer.from(await c.req.raw.arrayBuffer());

  const h = new Headers(c.req.raw.headers);
  for (const key of HOP_BY_HOP_HEADERS) h.delete(key);
  h.delete('expect');
  // La URL pre-firmada ya lleva su propia autenticación (X-Amz-Signature en el query).
  // Cualquier Authorization/Cookie del cliente (p.ej. Bearer JWT del front) haría que MinIO
  // devuelva 400 "request has multiple authentication types".
  h.delete('authorization');
  h.delete('cookie');
  h.set('host', c.req.raw.headers.get('host') ?? targetUrl.host);
  h.set('content-length', String(body.length));
  h.set('X-Request-Id', requestId);

  const isHttps = targetUrl.protocol === 'https:';
  const lib = isHttps ? httpsRequest : httpRequest;

  return new Promise((resolve) => {
    const req = lib(
      {
        hostname: targetUrl.hostname,
        port: targetUrl.port ? Number(targetUrl.port) : isHttps ? 443 : 80,
        path: targetUrl.pathname + targetUrl.search,
        method: c.req.method,
        headers: Object.fromEntries(h.entries()),
      } as any,
      (res: any) => {
        const chunks: Buffer[] = [];
        res.on('data', (d: Buffer) => chunks.push(d));
        res.on('end', () => {
          resolve(
            new Response(Buffer.concat(chunks), {
              status: res.statusCode,
              statusText: res.statusMessage,
              headers: sanitizeResponseHeaders(new Headers(res.headers)),
            }),
          );
        });
      },
    );
    req.on('error', (err: Error) => {
      log('Raw S3 proxy error:', err);
      resolve(c.json(errorBody('DOWNSTREAM_ERROR', 'Error al conectar con el almacenamiento'), 502));
    });
    req.end(body);
  });
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

  if (service.name === 'store') {
    return proxyRawS3(c, rule, service, requestId);
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

  // Reenviar el body como buffer para preservar Content-Length de forma determinista
  // (MinIO/la firma SigV4 del presigned exige Content-Length; un stream devuelve chunked sin él).
  const hasBody = c.req.method !== 'GET' && c.req.method !== 'HEAD';
  const body = hasBody ? await c.req.raw.arrayBuffer() : null;
  const init: RequestInit = {
    method: c.req.method,
    headers: downstreamHeaders,
    redirect: 'manual',
  };
  if (body) {
    init.body = new Uint8Array(body);
    downstreamHeaders.set('Content-Length', String(body.byteLength));
  }

  // undici (Node.js fetch) no soporta ciertos headers del cliente original
  downstreamHeaders.delete('expect');

  // Sin esto, un fetch() colgado (p.ej. un socket keep-alive reusado justo
  // cuando el servidor downstream lo cerraba por idle - carrera clasica entre
  // el keepAliveTimeout de @hono/node-server, 5s por defecto, y el pool de
  // undici) esperaba PARA SIEMPRE: sin error, sin log, nada - el cliente solo
  // veia su propio timeout (p.ej. los 10s de k6 en stress-petitions).
  // Medido: golpeando billing-service directo (sin este proxy) respondia en
  // 66ms; la misma peticion via este proxy se colgaba de forma indefinida.
  // DOWNSTREAM_TIMEOUT_MS deliberadamente mas holgado que timeouts tipicos de
  // cliente (10-15s): el objetivo es que el gateway deje de trabarse para
  // siempre, no imponer un SLA nuevo mas estricto que el que ya tenia.
  const timeoutMs = Number(process.env.DOWNSTREAM_TIMEOUT_MS) || 20_000;
  const downstreamReq = new Request(targetUrlStr, { ...init, signal: AbortSignal.timeout(timeoutMs) });

  try {
    const response = await fetch(downstreamReq);
    // Bufferear el body en vez de reenviar response.body (el ReadableStream
    // crudo de undici): undici NO libera el socket downstream al pool de
    // conexiones hasta que el body se consume por completo. Reenviar el
    // stream tal cual deja esa liberacion en manos de que Hono/el resto del
    // middleware (p.ej. el rate-limit, que hace c.res.headers.set(...)
    // DESPUES de next()) lo drene correctamente - y no siempre lo hacia.
    // Medido: ESTABLISHED en /proc/net/tcp del pod crecia 1 a 1 con cada
    // request (33 -> 1609 en 56s bajo 25 rps) sin bajar nunca - una fuga de
    // conexiones/file descriptors, no un techo de concurrencia real. Las
    // respuestas de esta API son JSON chico, asi que bufferear entero no
    // tiene costo relevante.
    const bodyBuffer = await response.arrayBuffer();
    return new Response(bodyBuffer, {
      status: response.status,
      statusText: response.statusText,
      headers: sanitizeResponseHeaders(response.headers),
    });
  } catch (err) {
    if (err instanceof Error && err.name === 'TimeoutError') {
      log('Proxy timeout:', targetUrlStr);
      return c.json(
        errorBody('DOWNSTREAM_TIMEOUT', 'El servicio downstream no respondió a tiempo'),
        504,
      );
    }
    log('Proxy error:', err);
    return c.json(
      errorBody('DOWNSTREAM_ERROR', 'Error al conectar con el servicio downstream'),
      502,
    );
  }
}
