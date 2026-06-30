/**
 * Tipos del motor del gateway. Todo lo específico de una app se expresa como
 * datos de este tipo; el motor (core/) no conoce ninguna app ni dominio.
 */

/** Lee un header del request entrante (independiente del framework). */
export type GetHeader = (name: string) => string | undefined;

/** Resultado de autenticar una petición. */
export interface AuthResult {
  authenticated: boolean;
  claims?: Record<string, unknown>;
  error?: string;
}

/**
 * Puerto de autenticación. La implementación por defecto es JWT (RS256), pero
 * otra app puede inyectar otra (tokens opacos + introspección, API keys, …).
 */
export interface Authenticator {
  authenticate(getHeader: GetHeader): Promise<AuthResult>;
}

/** Proyección de un claim del token a un header de contexto hacia el downstream. */
export interface ClaimHeaderMapping {
  claim: string; // nombre del claim en el payload del JWT
  header: string; // header a inyectar (ej. 'X-User-Id')
}

export type HttpMethod =
  | 'GET'
  | 'POST'
  | 'PUT'
  | 'PATCH'
  | 'DELETE'
  | 'OPTIONS'
  | 'HEAD'
  | 'ANY';

/**
 * Regla de ruta. Se evalúan en orden; la primera que coincide gana.
 * `path` admite coincidencia exacta ('/auth/login') o por prefijo ('/auth/*').
 */
export interface RouteRule {
  method: HttpMethod; // 'ANY' coincide con cualquier método
  path: string;
  service: string; // nombre del servicio destino (clave en services)
  public?: boolean; // true = no exige token
  stripPrefix?: string; // prefijo a quitar antes de reenviar (opcional)
}

export interface ServiceConfig {
  name: string;
  url: string; // URL base del servicio downstream
}

/** Store de rate-limit (inyectable: in-memory por defecto, Redis para multi-instancia). */
export interface RateLimitStore {
  hit(key: string, windowMs: number): Promise<{ count: number; resetAt: number }>;
}

export interface RateLimitConfig {
  windowMs: number;
  max: number;
  store?: RateLimitStore;
}

export interface CorsConfig {
  origin: string | string[];
}

/** Configuración completa del gateway: el perfil de una app. */
export interface GatewayConfig {
  authenticator: Authenticator;
  claimHeaders: ClaimHeaderMapping[];
  services: ServiceConfig[];
  routes: RouteRule[];
  cors?: CorsConfig;
  rateLimit?: RateLimitConfig;
  requestIdHeader?: string; // por defecto 'X-Request-Id'
}
