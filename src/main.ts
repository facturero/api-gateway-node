import 'dotenv/config';
import './infrastructure/telemetry/otel';
import { createAdaptorServer } from '@hono/node-server';
import type { Server as HttpServer } from 'node:http';
import { loadEnv } from './config/env';
import { buildGatewayConfig } from './config/gateway.config';
import { createGateway } from './core/create-gateway';
import { createRealtimeHub } from './realtime/hub';

const env = loadEnv();
const config = buildGatewayConfig();
const app = createGateway(config);

// Carga IPs confiables desde auth-service (refresh cada 30s)
config.rateLimit?.trustedIpCache?.start().catch(() => {});

// El server HTTP lo creamos nosotros para montar socket.io (/ws) sobre él.
// El hub autentica con el mismo JWT y reenvía eventos de catálogo por org.
const httpServer = createAdaptorServer({ fetch: app.fetch }) as HttpServer;
createRealtimeHub({
  httpServer,
  authenticator: config.authenticator,
  rabbitmqUrl: env.RABBITMQ_URL,
});

httpServer.listen(env.PORT, () => {
  console.log(`Gateway escuchando en http://localhost:${env.PORT}`);
});
