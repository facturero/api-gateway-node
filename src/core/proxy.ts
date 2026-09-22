import type { Context } from 'hono';
import type { RouteRule, ServiceConfig } from './types';
import { errorBody } from './errors';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { Agent } from 'undici';

// eslint-disable-next-line no-console
const log = console.error.bind(console, '[proxy]');

// Agent unico y compartido para el fetch() del proxy hacia los servicios
// downstream. Sin esto, fetch() usa el dispatcher global de undici tal cual
// - y en la practica el pod terminaba abriendo una conexion TCP nueva por
// cada peticion en vez de reusar: bajo carga sostenida real (25 rps durante
// varios minutos via stress-petitions/billing, no en rafagas cortas) los
// sockets en TIME_WAIT (que Linux tarda ~60s en liberar) se acumulaban mas
// rapido de lo que se liberaban - medido en /proc/net/tcp del pod, hasta
// 1500+ sockets simultaneos - y el proceso terminaba sin file descriptors
// disponibles. `connections` acota cuantos sockets simultaneos por origen
// puede abrir el pool (backpressure real en vez de crecimiento sin techo);
// `keepAliveTimeout`/`keepAliveMaxTimeout` generosos para que de verdad se
// reusen entre peticiones seguidas en vez de cerrarse por estar unos pocos
// segundos idle.
const downstreamAgent = new Agent({
  connections: 64,
  keepAliveTimeout: 30_000,
  keepAliveMaxTimeout: 60_000,
});

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

  // Reenviar el body como buffer (no como stream) para que el proxy pueda
  // reintentar/leer sin depender de un stream que ya se consumio.
  // Content-Length se lo dejamos calcular a undici a partir del body: con
  // el Agent dedicado (mas estricto que el fetch global de Node en esto),
  // setearlo a mano aca causaba "InvalidArgumentError: invalid content-length
  // header" - el body ya viene como Content-Length correcto de por si desde
  // el cliente original, y duplicar el calculo no aportaba nada en este
  // codepath (a diferencia de proxyRawS3/MinIO, que si lo necesita para el
  // SigV4 y esta en otra funcion, sin tocar).
  const hasBody = c.req.method !== 'GET' && c.req.method !== 'HEAD';
  const body = hasBody ? await c.req.raw.arrayBuffer() : null;
  downstreamHeaders.delete('content-length');
  const init: RequestInit = {
    method: c.req.method,
    headers: downstreamHeaders,
    redirect: 'manual',
  };
  if (body) {
    init.body = new Uint8Array(body);
  }

  // undici (Node.js fetch) no soporta ciertos headers del cliente original
  downstreamHeaders.delete('expect');

  // DOWNSTREAM_TIMEOUT_MS: red de seguridad para que el gateway deje de
  // trabarse para siempre si el downstream no responde (ver historia larga
  // en git log de este archivo). Ojo: a proposito NO se implementa con un
  // AbortSignal pasado al fetch. Abortar el fetch mientras esta en vuelo
  // deja el socket subyacente de undici en un estado que no siempre se
  // libera al pool de conexiones - medido en vivo: bajo carga real (25 rps
  // sostenidos vía stress-petitions/billing) ESTABLISHED en /proc/net/tcp
  // del pod crecia sin bajar nunca, aun con el AbortSignal puesto y aun
  // bufferizando el body de las respuestas EXITOSAS (fix anterior). El
  // patron de abajo no cancela nada: si el timeout gana la carrera, la
  // fetch original sigue viva en el fondo y se le consume el body entero
  // apenas resuelva (exito o no), garantizando que el socket se libere -
  // el cliente ya recibio su 504 y no espera esa segunda resolucion.
  // OJO: fetch(new Request(url, init), otroInit) NO respeta `dispatcher` en
  // ese segundo argumento - un Request ya construido encapsula sus propias
  // opciones y Node/undici ignora silenciosamente el dispatcher del otro
  // init. Por eso antes el Agent con connections:64 nunca se aplicaba de
  // verdad: bajo rafagas de concurrencia real (80 peticiones simultaneas,
  // incluso ya con este Agent "puesto") las 80 seguian tardando ~20s cada
  // una, exactamente igual que golpeando directo con fetch() global -
  // mientras que las mismas 80 directo a billing-service (sin este proxy)
  // respondian en <150ms. Pasando la URL + init (con dispatcher adentro)
  // directo a fetch(), sin construir un Request intermedio, si se respeta.
  // El cast pasa por `unknown`: @types/node trae su propio undici-types
  // (bundled) que TS considera un tipo distinto del paquete standalone
  // `undici` que se instalo aca, aunque sean estructuralmente el mismo
  // Agent en runtime.
  const fetchPromise = fetch(targetUrlStr, { ...init, dispatcher: downstreamAgent } as unknown as RequestInit);
  const timeoutMs = Number(process.env.DOWNSTREAM_TIMEOUT_MS) || 20_000;
  const TIMEOUT = Symbol('timeout');
  let resolveTimeout: (v: typeof TIMEOUT) => void;
  const timeoutPromise = new Promise<typeof TIMEOUT>((resolve) => {
    resolveTimeout = resolve;
  });
  const timer = setTimeout(() => resolveTimeout(TIMEOUT), timeoutMs);

  try {
    const winner = await Promise.race([fetchPromise, timeoutPromise]);
    clearTimeout(timer);

    if (winner === TIMEOUT) {
      log('Proxy timeout:', targetUrlStr);
      // Drenar en el fondo lo que sea que termine llegando, para liberar el
      // socket - sin esto se repite la misma fuga que con AbortSignal.
      fetchPromise.then((r) => r.arrayBuffer()).catch(() => undefined);
      return c.json(
        errorBody('DOWNSTREAM_TIMEOUT', 'El servicio downstream no respondió a tiempo'),
        504,
      );
    }

    const response = winner;
    // Bufferear el body en vez de reenviar response.body (el ReadableStream
    // crudo de undici): undici NO libera el socket downstream al pool de
    // conexiones hasta que el body se consume por completo. Reenviar el
    // stream tal cual deja esa liberacion en manos de que Hono/el resto del
    // middleware (p.ej. el rate-limit, que hace c.res.headers.set(...)
    // DESPUES de next()) lo drene correctamente - y no siempre lo hacia.
    const bodyBuffer = await response.arrayBuffer();
    return new Response(bodyBuffer, {
      status: response.status,
      statusText: response.statusText,
      headers: sanitizeResponseHeaders(response.headers),
    });
  } catch (err) {
    clearTimeout(timer);
    log('Proxy error:', err);
    return c.json(
      errorBody('DOWNSTREAM_ERROR', 'Error al conectar con el servicio downstream'),
      502,
    );
  }
}
