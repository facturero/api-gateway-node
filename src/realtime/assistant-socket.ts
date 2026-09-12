import type { Server as SocketServer, Socket } from 'socket.io';

/**
 * Canal del asistente sobre Socket.io.
 *
 * **Por qué existe en vez de usar el REST de `/assistant/messages`.**
 * Cloudflare Tunnel bufferiza las respuestas HTTP salvo `text/event-stream`
 * (documentado por Cloudflare), y cuando el origin tarda más de ~30s el túnel
 * corta con 502. El asistente puede tardar un minuto o más (el LLM local es
 * lento), así que toda petición larga por HTTP moría a los 30s — aunque el
 * assistant-service termina el turno igual y lo guarda en BD, la respuesta
 * nunca volvía al navegador.
 *
 * Los WebSockets NO pasan por ese buffer: el túnel los streamea en ambas
 * direcciones. Así la petición de un turno largo viaja por el socket, el
 * gateway llama al assistant-service por HTTP **interno** (red del cluster,
 * que no atraviesa el túnel ni tiene su cap), y la respuesta vuelve por el
 * socket. El cap de 30s ya no aplica en ningún punto.
 *
 * Los datos del contexto vienen de socket.data, que el hub rellena al
 * autenticar: organización, usuario y el Bearer original. Ese Bearer es
 * imprescindible: el assistant-service lo reutiliza para volver a llamar a
 * esta misma API en nombre del usuario.
 */
export interface AssistantSocketOptions {
  /** URL del assistant-service (red interna del cluster). Si falta, no se registra el canal. */
  assistantServiceUrl?: string;
}

/** Más generoso que el timeout del LLM (9 min en Ollama local): la ack del
 *  socketio distingue entre tardar y fallar. 11 min. */
const ACK_TIMEOUT_MS = 11 * 60_000;

export function registerAssistantSocket(io: SocketServer, options: AssistantSocketOptions): void {
  if (!options.assistantServiceUrl) return;

  io.on('connection', (socket) => {
    // Mandar un mensaje: arranca o continúa un hilo. Payload: { text, conversationId }.
    socket.on('assistant:send', (payload: unknown, ack?: (res: { ok: boolean; data?: unknown; message?: string }) => void) => {
      const text = typeof (payload as { text?: unknown })?.text === 'string' ? (payload as { text: string }).text : '';
      const conversationId =
        typeof (payload as { conversationId?: unknown })?.conversationId === 'string'
          ? (payload as { conversationId: string }).conversationId
          : null;

      void callAssistant(socket, options.assistantServiceUrl!, {
        path: '/assistant/messages',
        body: { text, conversationId },
        ack,
      });
    });

    // Confirmar o rechazar una escritura propuesta. Payload: { actionId, approve }.
    socket.on('assistant:decide', (payload: unknown, ack?: (res: { ok: boolean; data?: unknown; message?: string }) => void) => {
      const p = (payload ?? {}) as { actionId?: unknown; approve?: unknown };
      const actionId = typeof p.actionId === 'string' ? p.actionId : '';
      const approve = p.approve === true;

      void callAssistant(socket, options.assistantServiceUrl!, {
        path: `/assistant/actions/${encodeURIComponent(actionId)}/decide`,
        body: { approve },
        ack,
      });
    });
  });
}

async function callAssistant(
  socket: Socket,
  serviceUrl: string,
  params: {
    path: string;
    body: Record<string, unknown>;
    ack?: (res: { ok: boolean; data?: unknown; message?: string }) => void;
  },
): Promise<void> {
  const respond = (res: { ok: boolean; data?: unknown; message?: string }) => {
    // El cliente puede haberse desconectado mientras el turno corría: la ack
    // ya no tiene a quién llegar y emitir sobre un socket roto lanzaría.
    if (!socket.connected) {
      console.error('[assistant-socket] cliente desconectado antes de entregar el turno');
      return;
    }
    if (params.ack) {
      params.ack(res);
    } else {
      socket.emit('assistant:turn', res);
    }
  };

// Mima el contrato del proxy HTTP: mismos headers de contexto y mismo Bearer
    // original. Sin ellos el assistant responde ORG_CONTEXT_REQUIRED/TOKEN_REQUIRED.
    // X-User-Id es el `sub` del JWT (lo que el hub guardó en subjectId).
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ACK_TIMEOUT_MS);
    try {
      const response = await fetch(`${serviceUrl.replace(/\/+$/, '')}${params.path}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          'X-User-Id': String(socket.data.subjectId ?? ''),
          'X-Organization-Id': String(socket.data.organizationId ?? ''),
        'Accept-Language': String(socket.data.locale ?? 'es').slice(0, 2),
        Authorization: `Bearer ${socket.data.bearerToken ?? ''}`,
      },
      body: JSON.stringify(params.body),
      signal: controller.signal,
    });

    const text = await response.text();
    let body: unknown = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = text;
    }

    if (!response.ok) {
      const message =
        typeof (body as { message?: unknown })?.message === 'string'
          ? (body as { message: string }).message
          : 'El asistente no pudo completar el turno.';
      respond({ ok: false, message });
      return;
    }
    respond({ ok: true, data: body });
  } catch (error) {
    const aborted = error instanceof Error && error.name === 'AbortError';
    console.error('[assistant-socket] fallo llamando al assistant-service:', error);
    respond({
      ok: false,
      message: aborted
        ? 'El asistente tardó demasiado. Inténtalo de nuevo.'
        : 'No se pudo contactar con el asistente.',
    });
  } finally {
    clearTimeout(timer);
  }
}