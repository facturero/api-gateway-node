import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().int().positive().default(8080),

  JWT_PUBLIC_KEY_PATH: z.string().default('certs/public.pem'),
  JWT_PUBLIC_KEY: z.string().optional(),

  JWT_ISSUER: z.string().min(1),
  JWT_AUDIENCE: z.string().min(1),

  AUTH_SERVICE_URL: z.string().url(),

  CORS_ORIGIN: z.string().default('http://localhost:5173'),

  RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60000),
  RATE_LIMIT_MAX: z.coerce.number().int().positive().default(120),
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
