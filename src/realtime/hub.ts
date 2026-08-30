import { Server as SocketServer } from 'socket.io';
import type { Server as HttpServer } from 'node:http';
import { Channel, ChannelModel, connect, ConsumeMessage } from 'amqplib';
import type { Authenticator } from '../core/types';
const EXCHANGE = 'crm.events';
const ROOM_PREFIX = 'catalog:';
const DEVICE_ROOM_PREFIX = 'device:';

// Hub de tiempo real del gateway:
//  - Socket.io en /ws, autenticado con el mismo JWT (RS256) de auth-service.
//    Del claim org_id deriva la sala `catalog:<orgId>`; del claim sub deriva
//    `device:<sub>` (para terminales POS, sub = deviceId del equipo).
//  - Consume crm.events:
//      * product.product.*            -> `catalog.changed` a la org (el POS
//        hace un pull autenticado; aquí nunca va el catálogo completo).
//      * organization.billing_point.unlinked -> `pos.unlink` a `device:<deviceId>`
//        (el POS se desvincula solo, sin esperar a que el admin lo force).
//      * plugin.#                     -> `plugins.changed` a la org dueña del
//        evento (activaciones/desactivaciones y ciclo de plugins a medida).
export interface RealtimeHubOptions {
  httpServer: HttpServer;
  authenticator: Authenticator;
  rabbitmqUrl?: string;
  /** Se invoca con la organización afectada por cada evento `plugin.*`. */
  onPluginsChanged?: (organizationId: string) => void;
}

export function createRealtimeHub(options: RealtimeHubOptions): SocketServer {
  const io = new SocketServer(options.httpServer, {
    path: '/ws',
    cors: { origin: '*' },
  });

  // ── Autenticación por JWT (misma clave/emisor que el resto del API) ──
  io.use(async (socket, next) => {
    const fromAuth =
      (socket.handshake.auth as { token?: string } | undefined)?.token ?? undefined;
    const fromHeader = socket.handshake.headers.authorization
      ?.replace(/^Bearer\s+/i, '');
    const token = fromAuth ?? fromHeader;

    if (!token) {
      return next(new Error('Token no proporcionado'));
    }

    const result = await options.authenticator.authenticate(
      (name) => (name === 'authorization' ? `Bearer ${token}` : undefined),
    );

    if (!result.authenticated) {
      return next(new Error(result.error ?? 'Token inválido'));
    }

    const orgId = result.claims?.org_id as string | undefined;
    if (!orgId) {
      return next(new Error('El token no pertenece a una organización'));
    }

    socket.data.organizationId = orgId;
    socket.data.subjectId = (result.claims?.sub as string | undefined) ?? null;
    return next();
  });

  io.on('connection', (socket) => {
    const orgId = socket.data.organizationId as string;
    socket.join(`${ROOM_PREFIX}${orgId}`);
    // Para un terminal POS, sub == deviceId (el id de su pos_device). La sala
    // `device:<sub>` permite enrutarle eventos punto-a-punto (p.ej. la
    // desvinculación) sin depender de que esté en la sala de la org.
    const sub = socket.data.subjectId as string | null;
    if (sub) {
      socket.join(`${DEVICE_ROOM_PREFIX}${sub}`);
    }
  });

  if (options.rabbitmqUrl) {
    startRealtimeConsumer(io, options.rabbitmqUrl, options.onPluginsChanged).catch((err) => {
      console.error('[realtime] consumidor de eventos falló:', err);
    });
  }

  return io;
}

async function startRealtimeConsumer(
  io: SocketServer,
  rabbitmqUrl: string,
  onPluginsChanged?: (organizationId: string) => void,
): Promise<void> {
  const connectLoop = async (): Promise<void> => {
    try {
      const model: ChannelModel = await connect(rabbitmqUrl);
      const channel: Channel = await model.createChannel();
      await channel.assertExchange(EXCHANGE, 'topic', { durable: true });

      const { queue } = await channel.assertQueue('gateway.catalog.events', {
        durable: true,
      });
      await channel.bindQueue(queue, EXCHANGE, 'product.product.#');
      await channel.bindQueue(queue, EXCHANGE, 'organization.billing_point.#');
      await channel.bindQueue(queue, EXCHANGE, 'plugin.#');

      channel.consume(queue, (msg: ConsumeMessage | null) => {
        if (!msg) return;
        handleRealtimeMessage(io, channel, msg, onPluginsChanged).catch((err) => {
          console.error('[realtime] error al procesar evento:', err);
          channel.nack(msg, false, true);
        });
      });

      console.log('[realtime] consumidor crm.events activo (product.product.*, organization.billing_point.*, plugin.*)');
    } catch (err) {
      console.error('[realtime] no se pudo conectar a RabbitMQ, reintentando en 5s:', err);
      setTimeout(connectLoop, 5_000);
    }
  };

  await connectLoop();
}

async function handleRealtimeMessage(
  io: SocketServer,
  channel: Channel,
  msg: ConsumeMessage,
  onPluginsChanged?: (organizationId: string) => void,
): Promise<void> {
  if (!msg.fields || !msg.fields.routingKey) return;

  const routingKey = msg.fields.routingKey;
  const payload = JSON.parse(msg.content.toString()) as Record<string, unknown>;

  if (routingKey.startsWith('product.product.')) {
    const orgId = payload.organizationId as string | undefined;
    if (!orgId) {
      channel.nack(msg, false, false);
      return;
    }
    io.to(`${ROOM_PREFIX}${orgId}`).emit('catalog.changed', {
      event: routingKey,
      ...payload,
    });
    channel.ack(msg);
    return;
  }

  if (routingKey === 'organization.billing_point.unlinked') {
    // Avisa al terminal POS afectado (deviceId) para que se desvincule solo.
    const deviceId = payload.deviceId as string | undefined;
    if (!deviceId) {
      channel.ack(msg);
      return;
    }
    io.to(`${DEVICE_ROOM_PREFIX}${deviceId}`).emit('pos.unlink', {
      event: routingKey,
      ...payload,
    });
    channel.ack(msg);
    return;
  }

  if (routingKey.startsWith('plugin.')) {
    // Eventos del plugin-catalog: activaciones, desactivaciones y ciclo de
    // plugins a medida. Todos son por-organización; el campo que identifica a
    // la org varía según el evento (organizationId en la mayoría,
    // createdForOrganizationId en plugin.created).
    const orgId =
      (payload.organizationId as string | undefined) ??
      (payload.createdForOrganizationId as string | undefined);
    if (!orgId) {
      channel.nack(msg, false, false);
      return;
    }
    // El gate del gateway cachea los plugins activos por organizacion: hay que
    // invalidarla antes de avisar a los sockets, para que el refetch que dispara
    // el frontend ya lea el estado nuevo.
    onPluginsChanged?.(orgId);
    io.to(`${ROOM_PREFIX}${orgId}`).emit('plugins.changed', {
      event: routingKey,
      ...payload,
    });
    channel.ack(msg);
    return;
  }

  // 'organization.billing_point.paired' y cualquier otro evento: no hay nada
  // que reenviar a sockets todavía.
  channel.ack(msg);
}
