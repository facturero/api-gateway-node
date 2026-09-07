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
  // Activar o desactivar un plugin debe reflejarse en el gate al instante,
  // sin esperar al TTL de la cache.
  onPluginsChanged: (organizationId) => config.pluginGate?.cache.invalidate(organizationId),
  // Un cambio de identidad (role.updated, user.disabled/enabled, ...) deja el
  // pv del token viejo: invalidar la caché para que la próxima request del
  // usuario afectado detecte TOKEN_STALE (BUG #9).
  onPermissionsChanged: (userIds) => {
    for (const uid of userIds) {
      config.permissionsCache?.invalidate(uid);
    }
  },
});

httpServer.listen(env.PORT, () => {
  console.log(`Gateway escuchando en http://localhost:${env.PORT}`);
});
