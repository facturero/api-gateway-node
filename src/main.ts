import 'dotenv/config';
import { serve } from '@hono/node-server';
import { loadEnv } from './config/env';
import { buildGatewayConfig } from './config/gateway.config';
import { createGateway } from './core/create-gateway';

const env = loadEnv();
const config = buildGatewayConfig();
const app = createGateway(config);

console.log(`Gateway escuchando en http://localhost:${env.PORT}`);
serve({ fetch: app.fetch, port: env.PORT });
