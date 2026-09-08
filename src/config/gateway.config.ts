import { readFileSync } from 'node:fs';
import { loadEnv } from './env';
import { JwtAuthenticator } from '../core/authenticator';
import type { GatewayConfig } from '../core/types';
import { TrustedIpCache } from '../core/trusted-ip-cache';
import { PluginActivationCache } from '../core/plugin-activation-cache';
import { PermissionsVersionCache } from '../core/permissions-cache';

/**
 * Normaliza una clave PEM que puede venir con `\n` como texto literal (típico
 * en archivos .env / secrets, donde no se interpretan escapes) o con saltos de
 * línea reales. OpenSSL solo acepta saltos reales; sin esto, el parser lanza
 * `header too long` y todo JWT es rechazado.
 */
function normalizePem(pem: string): string {
  // Reemplaza "\n" literal (backslash + n) por salto de línea real.
  return pem.replace(/\\n/g, '\n').trim();
}

export function buildGatewayConfig(): GatewayConfig {
  const env = loadEnv();

  const rawPublicKey =
    env.JWT_PUBLIC_KEY ?? readFileSync(env.JWT_PUBLIC_KEY_PATH, 'utf-8');
  const publicKey = normalizePem(rawPublicKey);

  const authenticator = new JwtAuthenticator({
    publicKey,
    issuer: env.JWT_ISSUER,
    audience: env.JWT_AUDIENCE,
  });

  const services: GatewayConfig['services'] = [{ name: 'auth-service', url: env.AUTH_SERVICE_URL }];

  if (env.ORG_SERVICE_URL) services.push({ name: 'org-service', url: env.ORG_SERVICE_URL });
  if (env.CUSTOMER_SERVICE_URL) services.push({ name: 'customer-service', url: env.CUSTOMER_SERVICE_URL });
  if (env.PRODUCT_SERVICE_URL) services.push({ name: 'product-service', url: env.PRODUCT_SERVICE_URL });
  if (env.TAX_SERVICE_URL) services.push({ name: 'tax-service', url: env.TAX_SERVICE_URL });
  if (env.BILLING_SERVICE_URL) services.push({ name: 'billing-service', url: env.BILLING_SERVICE_URL });
  if (env.FISCAL_SERVICE_URL) services.push({ name: 'fiscal-ecuador', url: env.FISCAL_SERVICE_URL });

  if (env.DOCUMENT_SERVICE_URL) services.push({ name: 'document-service', url: env.DOCUMENT_SERVICE_URL });
  if (env.PLUGIN_CATALOG_SERVICE_URL) services.push({ name: 'plugin-catalog-service', url: env.PLUGIN_CATALOG_SERVICE_URL });
  if (env.STORE_SERVICE_URL) services.push({ name: 'store', url: env.STORE_SERVICE_URL });
  if (env.NOTIFICATION_SERVICE_URL) services.push({ name: 'notification-service', url: env.NOTIFICATION_SERVICE_URL });
  if (env.AUDIT_LOG_SERVICE_URL) services.push({ name: 'audit-log-service', url: env.AUDIT_LOG_SERVICE_URL });
  const pluginActivations = env.PLUGIN_CATALOG_SERVICE_URL
    ? new PluginActivationCache(env.PLUGIN_CATALOG_SERVICE_URL)
    : null;

  const fallbackIps = env.RATE_LIMIT_TRUSTED_IPS
    ? env.RATE_LIMIT_TRUSTED_IPS.split(',').map((s) => s.trim())
    : [];

  const trustedIpCache = new TrustedIpCache(
    env.AUTH_SERVICE_URL,
    fallbackIps,
    env.TRUSTED_IPS_REFRESH_MS,
  );

  // BUG #9: valida el pv de cada token contra auth-service (TTL corto, fail-open).
  const permissionsCache = new PermissionsVersionCache(
    env.AUTH_SERVICE_URL,
    env.INTERNAL_SERVICE_SECRET,
  );

  return {
    authenticator,
    claimHeaders: [
      { claim: 'sub', header: 'X-User-Id' },
      { claim: 'email', header: 'X-User-Email' },
      { claim: 'org_id', header: 'X-Organization-Id' },
      { claim: 'country_code', header: 'X-Country-Code' },
      { claim: 'permissions', header: 'X-Permissions' },
    ],
    services,
    permissionsCache,
    routes: [
      { method: 'POST', path: '/auth/register', service: 'auth-service', public: true },
      { method: 'POST', path: '/auth/login', service: 'auth-service', public: true },
      { method: 'POST', path: '/auth/google', service: 'auth-service', public: true },
      { method: 'POST', path: '/auth/refresh', service: 'auth-service', public: true },
      { method: 'POST', path: '/auth/logout', service: 'auth-service', public: true },
      { method: 'POST', path: '/auth/accept-invite', service: 'auth-service', public: true },
      // Sin esta regla, /auth/password-reset caía en el catch-all de abajo
      // (public: false) — el gateway exigía un Bearer token para consumir un
      // link de "olvidé mi contraseña", que por definición es para alguien
      // SIN sesión activa. Bug real, no solo hueco de test (hallazgo #24).
      { method: 'POST', path: '/auth/password-reset', service: 'auth-service', public: true },
      { method: 'ANY', path: '/auth/*', service: 'auth-service', public: false },

      { method: 'GET', path: '/trusted-ips/enabled', service: 'auth-service', public: true },
      { method: 'ANY', path: '/trusted-ips/*', service: 'auth-service' },

      { method: 'ANY', path: '/users/*', service: 'auth-service' },
      { method: 'ANY', path: '/roles/*', service: 'auth-service' },
      { method: 'GET', path: '/permissions', service: 'auth-service' },

      // plugin-catalog-service — estas reglas DEBEN ir antes de '/organizations/*'
      { method: 'GET', path: '/plugins', service: 'plugin-catalog-service', public: true },
      { method: 'ANY', path: '/organizations/me/plugins/*', service: 'plugin-catalog-service', stripPrefix: '' },
      { method: 'ANY', path: '/organizations/me/plugins', service: 'plugin-catalog-service', stripPrefix: '' },
      { method: 'ANY', path: '/organizations/me/plugin-requests', service: 'plugin-catalog-service', stripPrefix: '' },
      { method: 'ANY', path: '/admin/plugin-requests/*', service: 'plugin-catalog-service', stripPrefix: '' },

      // notification-service — catálogo de providers y preferencias por usuario.
      { method: 'ANY', path: '/notifications/*', service: 'notification-service', stripPrefix: '' },

      // audit-log-service — bitácora de solo lectura; el gateway exige audit:read y
      // el servicio hace su propio chequeo fino del X-Permissions inyectado.
      // GET y no ANY: la bitácora es de solo lectura. Con ANY el gateway
      // reenviaba POST/PUT/DELETE para que el servicio contestara 404 — mejor
      // que ni salgan de aquí.
      { method: 'GET', path: '/audit-logs/*', service: 'audit-log-service', stripPrefix: '', permission: 'audit:read' },

      { method: 'ANY', path: '/organizations/*', service: 'org-service', stripPrefix: '' },
      { method: 'ANY', path: '/establishments/*', service: 'org-service', stripPrefix: '', requiresPlugin: 'org.establishments' },
      { method: 'POST', path: '/billing-points/pair', service: 'org-service', stripPrefix: '', public: true, rateLimit: { windowMs: 60_000, max: 5 } },

      { method: 'ANY', path: '/customers/*', service: 'customer-service', stripPrefix: '', requiresPlugin: 'crm.contacts' },
      { method: 'ANY', path: '/contacts/*', service: 'customer-service', stripPrefix: '', requiresPlugin: 'crm.contacts' },
      { method: 'ANY', path: '/addresses/*', service: 'customer-service', stripPrefix: '', requiresPlugin: 'crm.contacts' },
      { method: 'ANY', path: '/tags/*', service: 'customer-service', stripPrefix: '', requiresPlugin: 'crm.contacts' },
      { method: 'ANY', path: '/identification-types/*', service: 'customer-service', stripPrefix: '' },

      { method: 'ANY', path: '/products/*', service: 'product-service', stripPrefix: '' },
      { method: 'ANY', path: '/categories/*', service: 'product-service', stripPrefix: '' },
      { method: 'ANY', path: '/units/*', service: 'product-service', stripPrefix: '' },
      { method: 'ANY', path: '/tax-rates/*', service: 'product-service', stripPrefix: '' },

      { method: 'ANY', path: '/invoices/*', service: 'billing-service', stripPrefix: '', requiresPlugin: 'finance.electronic_invoicing' },

      { method: 'ANY', path: '/fiscal-invoices/*', service: 'fiscal-ecuador', stripPrefix: '', requiresPlugin: 'finance.electronic_invoicing' },
      { method: 'ANY', path: '/certificates/*', service: 'fiscal-ecuador', stripPrefix: '', requiresPlugin: 'finance.electronic_certificate' },

      { method: 'ANY', path: '/countries/*', service: 'tax-service', stripPrefix: '' },

      { method: 'GET', path: '/files/:id/download', service: 'document-service', stripPrefix: '', public: true },
      { method: 'ANY', path: '/files/*', service: 'document-service', stripPrefix: '' },

      // MinIO/S3 object store — la URL presigned firmada usa el bucket en el path (path-style),
      // por lo que el URI debe llegar intacto a MinIO (sin stripPrefix).
      { method: 'ANY', path: '/cmr-documents/*', service: 'store', stripPrefix: '', public: true },
    ],
    ...(pluginActivations
      ? { pluginGate: { cache: pluginActivations, organizationClaim: 'org_id' } }
      : {}),
    // CORS_ORIGIN admite varios orígenes separados por coma: en desarrollo el
    // front se abre tanto por localhost como por la IP de red (para probarlo
    // desde el móvil), y ambos tienen que pasar el preflight.
    cors: { origin: env.CORS_ORIGIN.split(',').map((o) => o.trim()).filter(Boolean) },
    rateLimit: {
      windowMs: env.RATE_LIMIT_WINDOW_MS,
      max: env.RATE_LIMIT_MAX,
      trustedIps: fallbackIps,
      trustedMax: env.RATE_LIMIT_TRUSTED_MAX,
      trustedIpCache,
    },
  };
}
