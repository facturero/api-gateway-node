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
  if (env.INVENTORY_SERVICE_URL) services.push({ name: 'inventory-service', url: env.INVENTORY_SERVICE_URL });
  if (env.TAX_SERVICE_URL) services.push({ name: 'tax-service', url: env.TAX_SERVICE_URL });
  if (env.BILLING_SERVICE_URL) services.push({ name: 'billing-service', url: env.BILLING_SERVICE_URL });
  if (env.FISCAL_SERVICE_URL) services.push({ name: 'fiscal-ecuador', url: env.FISCAL_SERVICE_URL });

  if (env.DOCUMENT_SERVICE_URL) services.push({ name: 'document-service', url: env.DOCUMENT_SERVICE_URL });
  if (env.PLUGIN_CATALOG_SERVICE_URL) services.push({ name: 'plugin-catalog-service', url: env.PLUGIN_CATALOG_SERVICE_URL });
  if (env.STORE_SERVICE_URL) services.push({ name: 'store', url: env.STORE_SERVICE_URL });
  if (env.NOTIFICATION_SERVICE_URL) services.push({ name: 'notification-service', url: env.NOTIFICATION_SERVICE_URL });
  if (env.AUDIT_LOG_SERVICE_URL) services.push({ name: 'audit-log-service', url: env.AUDIT_LOG_SERVICE_URL });
  if (env.ASSISTANT_SERVICE_URL) services.push({ name: 'assistant-service', url: env.ASSISTANT_SERVICE_URL });
  if (env.RESTAURANT_SERVICE_URL) services.push({ name: 'restaurant-service', url: env.RESTAURANT_SERVICE_URL });
  if (env.ACCOUNTING_SERVICE_URL) services.push({ name: 'accounting-service', url: env.ACCOUNTING_SERVICE_URL });
  if (env.TELEMETRY_COLLECTOR_URL) services.push({ name: 'otel-collector', url: env.TELEMETRY_COLLECTOR_URL });
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
      // Telemetría del navegador → colector OTLP/HTTP (SigNoz). Pública a propósito: los errores del login ocurren sin sesión.
      // Por eso va acotada: SOLO este endpoint exacto (sin comodín: nada más del colector queda expuesto), SOLO POST, tope de
      // tamaño y un límite propio por IP; no cuenta en el límite global (ver `skipPaths`).
      ...(env.TELEMETRY_COLLECTOR_URL
        ? [{
            method: 'POST' as const,
            path: '/telemetry/v1/traces',
            service: 'otel-collector',
            stripPrefix: '/telemetry',
            public: true,
            rateLimit: { windowMs: 60_000, max: 60 },
            maxBodyBytes: 256 * 1024,
          }]
        : []),
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
      { method: 'GET', path: '/business-profiles', service: 'plugin-catalog-service', public: true },
      { method: 'ANY', path: '/organizations/me/business-profiles/*', service: 'plugin-catalog-service', stripPrefix: '' },
      { method: 'ANY', path: '/organizations/me/business-profile', service: 'plugin-catalog-service', stripPrefix: '' },
      { method: 'ANY', path: '/organizations/me/plugins/*', service: 'plugin-catalog-service', stripPrefix: '' },
      { method: 'ANY', path: '/organizations/me/plugins', service: 'plugin-catalog-service', stripPrefix: '' },
      { method: 'ANY', path: '/organizations/me/plugin-requests', service: 'plugin-catalog-service', stripPrefix: '' },
      { method: 'ANY', path: '/admin/plugin-requests/*', service: 'plugin-catalog-service', stripPrefix: '' },
      // Prueba gratis e IVA, descuentos canjeados por la organización y administración de descuentos (plugins:admin).
      { method: 'ANY', path: '/organizations/me/subscription', service: 'plugin-catalog-service', stripPrefix: '' },
      { method: 'ANY', path: '/organizations/me/discount-redemptions', service: 'plugin-catalog-service', stripPrefix: '' },
      { method: 'ANY', path: '/admin/discounts', service: 'plugin-catalog-service', stripPrefix: '' },
      { method: 'ANY', path: '/admin/discounts/*', service: 'plugin-catalog-service', stripPrefix: '' },

      // notification-service — catálogo de providers y preferencias por usuario.
      { method: 'ANY', path: '/notifications/*', service: 'notification-service', stripPrefix: '' },

      // audit-log-service — bitácora de solo lectura; el gateway exige audit:read y
      // el servicio hace su propio chequeo fino del X-Permissions inyectado.
      // GET y no ANY: la bitácora es de solo lectura. Con ANY el gateway
      // reenviaba POST/PUT/DELETE para que el servicio contestara 404 — mejor
      // que ni salgan de aquí.
      { method: 'GET', path: '/audit-logs/*', service: 'audit-log-service', stripPrefix: '', permission: 'audit:read' },

      // assistant-service — el asistente que ejecuta acciones. No lleva
      // `requiresPlugin`: va incluido en la plataforma. El servicio necesita el
      // Authorization original (el proxy lo reenvía) porque vuelve a llamar a
      // esta misma API en nombre del usuario.
      { method: 'ANY', path: '/assistant/*', service: 'assistant-service', stripPrefix: '' },

      { method: 'ANY', path: '/organizations/*', service: 'org-service', stripPrefix: '' },
      { method: 'ANY', path: '/establishments/*', service: 'org-service', stripPrefix: '', requiresPlugin: 'org.establishments' },
      { method: 'POST', path: '/billing-points/pair', service: 'org-service', stripPrefix: '', public: true, rateLimit: { windowMs: 60_000, max: 5 } },

      { method: 'ANY', path: '/customers/*', service: 'customer-service', stripPrefix: '', requiresPlugin: 'crm.contacts' },
      { method: 'ANY', path: '/contacts/*', service: 'customer-service', stripPrefix: '', requiresPlugin: 'crm.contacts' },
      { method: 'ANY', path: '/addresses/*', service: 'customer-service', stripPrefix: '', requiresPlugin: 'crm.contacts' },
      { method: 'ANY', path: '/tags/*', service: 'customer-service', stripPrefix: '', requiresPlugin: 'crm.contacts' },
      { method: 'ANY', path: '/identification-types/*', service: 'customer-service', stripPrefix: '' },

      { method: 'ANY', path: '/products/*', service: 'product-service', stripPrefix: '', requiresPlugin: 'infra.catalog_products' },
      { method: 'ANY', path: '/categories/*', service: 'product-service', stripPrefix: '', requiresPlugin: 'infra.catalog_products' },
      { method: 'ANY', path: '/units/*', service: 'product-service', stripPrefix: '', requiresPlugin: 'infra.catalog_products' },
      { method: 'ANY', path: '/tax-rates/*', service: 'product-service', stripPrefix: '', requiresPlugin: 'infra.catalog_products' },

      // Bodegas y kardex cuelgan de plugins distintos a propósito: se puede
      // tener kardex con una sola bodega y el concepto oculto en el frontend.
      // OJO: esto solo corta el HTTP. El consumo de stock por venta llega por
      // RabbitMQ, que no pasa por aquí, y lo corta inventory-service por su
      // cuenta (ver su IMPLEMENTATION.md, "El plugin apagado apaga el servicio").
      { method: 'ANY', path: '/warehouses/*', service: 'inventory-service', stripPrefix: '', requiresPlugin: 'inventory.warehouses' },
      { method: 'ANY', path: '/stock/*', service: 'inventory-service', stripPrefix: '', requiresPlugin: 'inventory.kardex' },

      // Restaurantes (módulo de pago `restaurant.floorplan`): mesas, plano y horarios. Igual que con /warehouses/*,
      // esto SOLO corta el HTTP: restaurant-service no consume eventos en este entregable, así que no hay ningún
      // read-model de activación que apagar (a diferencia de inventory-service, que corta el consumo de stock por RabbitMQ).
      // El servicio sirve sus rutas con el prefijo `/restaurant`, por eso `stripPrefix: ''`.
      //
      // Regla aparte (y ANTES del comodín: gana la primera que coincide) solo para subir el tope de tamaño del guardado
      // del plano. El editor manda el local entero —paredes, puertas, mesas, zonas— en un único PUT atómico de hasta
      // ~256 KB; con el tope por defecto no cabría. Solo esta ruta necesita pasar de 256 KB.
      { method: 'PUT', path: '/restaurant/floors/:floorId/plan', service: 'restaurant-service', stripPrefix: '', requiresPlugin: 'restaurant.floorplan', maxBodyBytes: 512 * 1024 },
      { method: 'ANY', path: '/restaurant/*', service: 'restaurant-service', stripPrefix: '', requiresPlugin: 'restaurant.floorplan' },

      // Contabilidad general (módulo de pago `finance.general_ledger`): plan de cuentas, periodos, asientos y balance. El servicio
      // sirve sus rutas con el prefijo `/accounting`, por eso `stripPrefix: ''`. Un asiento puede llevar hasta 500 líneas: las
      // reglas de escritura de asientos suben el tope de tamaño (van ANTES del comodín: gana la primera que coincide).
      { method: 'ANY', path: '/accounting/journal-entries', service: 'accounting-service', stripPrefix: '', requiresPlugin: 'finance.general_ledger', maxBodyBytes: 512 * 1024 },
      { method: 'ANY', path: '/accounting/journal-entries/:id', service: 'accounting-service', stripPrefix: '', requiresPlugin: 'finance.general_ledger', maxBodyBytes: 512 * 1024 },
      { method: 'ANY', path: '/accounting/*', service: 'accounting-service', stripPrefix: '', requiresPlugin: 'finance.general_ledger' },

      { method: 'ANY', path: '/invoices/*', service: 'billing-service', stripPrefix: '', requiresPlugin: 'finance.electronic_invoicing' },

      { method: 'ANY', path: '/fiscal-invoices/*', service: 'fiscal-ecuador', stripPrefix: '', requiresPlugin: 'finance.electronic_invoicing' },
      // Retenciones y guías de remisión que fiscal emite por su cuenta (`/fiscal/withholdings`, `/fiscal/delivery-guides`, catálogo
      // de códigos). Salen de la misma facturación electrónica: sin ella no hay certificado ni numeración ante el SRI. Una guía
      // con 50 destinatarios y 200 mercaderías cada uno pesa unos cientos de KB, de ahí el tope.
      { method: 'ANY', path: '/fiscal/*', service: 'fiscal-ecuador', stripPrefix: '', requiresPlugin: 'finance.electronic_invoicing', maxBodyBytes: 512 * 1024 },
      { method: 'ANY', path: '/certificates/*', service: 'fiscal-ecuador', stripPrefix: '', requiresPlugin: 'finance.electronic_certificate' },

      { method: 'ANY', path: '/countries/*', service: 'tax-service', stripPrefix: '' },

      // Ya no es pública (FACTURACION-BRECHAS.md, N13): con solo el id cualquiera
      // obtenía un enlace a cualquier archivo. La interfaz pide GET /files/:id/url
      // con su token; document-service acota a la organización.
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
    // `traceparent`/`tracestate`: el navegador los añade a cada llamada para enlazar su traza con la del backend; sin ellos
    // en la lista, el preflight rechaza TODAS las peticiones.
    cors: {
      origin: env.CORS_ORIGIN.split(',').map((o) => o.trim()).filter(Boolean),
      allowHeaders: ['traceparent', 'tracestate'],
    },
    rateLimit: {
      windowMs: env.RATE_LIMIT_WINDOW_MS,
      max: env.RATE_LIMIT_MAX,
      trustedIps: fallbackIps,
      trustedMax: env.RATE_LIMIT_TRUSTED_MAX,
      trustedIpCache,
      skipPaths: ['/telemetry/'],
    },
  };
}
