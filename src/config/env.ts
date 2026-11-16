import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().int().positive().default(8080),

  JWT_PUBLIC_KEY_PATH: z.string().default('certs/public.pem'),
  JWT_PUBLIC_KEY: z.string().optional(),

  JWT_ISSUER: z.string().min(1),
  JWT_AUDIENCE: z.string().min(1),

  AUTH_SERVICE_URL: z.string().url(),
  INTERNAL_SERVICE_SECRET: z.string().optional(),
  ORG_SERVICE_URL: z.string().url().optional(),
  CUSTOMER_SERVICE_URL: z.string().url().optional(),
  PRODUCT_SERVICE_URL: z.string().url().optional(),
  INVENTORY_SERVICE_URL: z.string().url().optional(),
  TAX_SERVICE_URL: z.string().url().optional(),
  BILLING_SERVICE_URL: z.string().url().optional(),
  FISCAL_SERVICE_URL: z.string().url().optional(),
  DOCUMENT_SERVICE_URL: z.string().url().optional(),
  PLUGIN_CATALOG_SERVICE_URL: z.string().url().optional(),
  STORE_SERVICE_URL: z.string().url().optional(),
  NOTIFICATION_SERVICE_URL: z.string().url().optional(),
  AUDIT_LOG_SERVICE_URL: z.string().url().optional(),
  ASSISTANT_SERVICE_URL: z.string().url().optional(),
  RESTAURANT_SERVICE_URL: z.string().url().optional(),
  ACCOUNTING_SERVICE_URL: z.string().url().optional(),
  PURCHASING_SERVICE_URL: z.string().url().optional(),
  TREASURY_SERVICE_URL: z.string().url().optional(),
  REPORTING_SERVICE_URL: z.string().url().optional(),
  PROJECTS_SERVICE_URL: z.string().url().optional(),
  // Mensajería (chat-service). Sin ella no se registra /chat/* y el hub no entrega mensajes (no puede pedirlos).
  CHAT_SERVICE_URL: z.string().url().optional(),
  // Comentarios, mejoras y puntos de fidelidad (feedback-service). Sin ella no se registra /feedback/*.
  FEEDBACK_SERVICE_URL: z.string().url().optional(),
  // Secreto de las rutas `/internal/*` de chat-service (el hub pide ahí los mensajes: los eventos no llevan texto). Es el mismo
  // Secret `internal-service-secret` del clúster, pero en su PROPIA variable: poner INTERNAL_SERVICE_SECRET encendería además la
  // comprobación de tokens viejos (BUG #9), que hoy está apagada en producción. Decisión del dueño, 2026-11-14.
  CHAT_INTERNAL_SECRET: z.string().optional(),
  // Colector OTLP/HTTP al que se reenvía la telemetría del navegador (`POST /telemetry/v1/traces`). Sin él, la ruta no existe.
  TELEMETRY_COLLECTOR_URL: z.string().url().optional(),

  CORS_ORIGIN: z.string().default('http://localhost:5173'),

  RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60000),
  RATE_LIMIT_MAX: z.coerce.number().int().positive().default(120),

  RATE_LIMIT_TRUSTED_IPS: z.string().optional(),
  RATE_LIMIT_TRUSTED_MAX: z.coerce.number().int().positive().default(600),
  TRUSTED_IPS_REFRESH_MS: z.coerce.number().int().positive().default(30000),

  RABBITMQ_URL: z.string().optional(),
});

export type Env = z.infer<typeof envSchema>;

let _env: Env | undefined;

export function loadEnv(): Env {
  if (!_env) {
    const parsed = envSchema.safeParse(process.env);
    if (!parsed.success) {
      console.error('Variables de entorno inválidas:');
      for (const issue of parsed.error.issues) {
        console.error(`  - ${issue.path.join('.')}: ${issue.message}`);
      }
      process.exit(1);
    }
    _env = parsed.data;
  }
  return _env;
}
