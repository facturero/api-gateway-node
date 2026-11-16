/**
 * Mensajería al estilo Slack (chat-service; contrato en `backend/chat-service/docs/tiempo-real.md`).
 *
 * Puro y probado (como `projects-routing.ts`): traduce un evento `chat.*` a lo que el hub debe emitir. El hub solo ejecuta el plan.
 *
 * - Los eventos NO traen el texto de los mensajes (regla 10 de chat-service: InboxConsumer guarda cada payload en `processed_events` y la
 *   bitácora consume `#`). Para `chat.message.created|updated` el plan pide al hub que traiga el mensaje (`deliverMessage`) y lo reparta a
 *   la sala `user:<uid>` de cada destinatario.
 * - Cambios de un canal PÚBLICO: aviso mínimo `{ event, conversationId }` a la sala de la organización (el cliente vuelve a pedir por REST).
 *   Privados y DMs: a las salas de sus miembros, para no filtrar el nombre de un canal privado a toda la organización.
 * - `chat.conversation.read`: solo a quien leyó (sincroniza sus pestañas y equipos).
 */
export interface ChatEmit {
  room: string;
  event: string;
  data: Record<string, unknown>;
}

export interface ChatDelivery {
  messageId: string;
  event: 'chat.message.new' | 'chat.message.updated';
  conversationId: string;
  threadRootId: string | null;
  /** Destinatarios con su aviso del navegador. `here`: lo decide el hub con su presencia (solo a los conectados). */
  recipients: Array<{ userId: string; notify: boolean; here: boolean }>;
}

export interface ChatPlan {
  organizationId: string;
  emits: ChatEmit[];
  deliver: ChatDelivery | null;
  /** Campana: los `userIds` del evento (el hub los pasa por el gate de preferencias de notification-service). */
  bellUserIds: string[];
}

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);

export function chatPlan(routingKey: string, payload: Record<string, unknown>, orgRoomPrefix: string, userRoomPrefix: string): ChatPlan | null {
  if (!routingKey.startsWith('chat.')) return null;
  const organizationId = str(payload.organizationId);
  const conversationId = str(payload.conversationId);
  if (!organizationId || !conversationId) return null;

  const userRoom = (u: string) => `${userRoomPrefix}${u}`;
  const members = strings(payload.memberUserIds);
  const plan: ChatPlan = { organizationId, emits: [], deliver: null, bellUserIds: [] };

  if (routingKey === 'chat.message.created' || routingKey === 'chat.message.updated') {
    const messageId = str(payload.messageId);
    if (!messageId) return null;
    const notify = new Set(strings(payload.notifyUserIds));
    const here = new Set(strings(payload.hereUserIds));
    plan.deliver = {
      messageId,
      event: routingKey === 'chat.message.created' ? 'chat.message.new' : 'chat.message.updated',
      conversationId,
      threadRootId: str(payload.threadRootId),
      // Una edición no vuelve a avisar.
      recipients: members.map((userId) => ({ userId, notify: routingKey === 'chat.message.created' && notify.has(userId), here: routingKey === 'chat.message.created' && here.has(userId) })),
    };
    if (routingKey === 'chat.message.created') plan.bellUserIds = strings(payload.userIds);
    return plan;
  }

  if (routingKey === 'chat.message.deleted') {
    const data = { messageId: str(payload.messageId), conversationId, threadRootId: str(payload.threadRootId) };
    plan.emits = members.map((u) => ({ room: userRoom(u), event: 'chat.message.deleted', data }));
    return plan;
  }

  if (routingKey === 'chat.reaction.added' || routingKey === 'chat.reaction.removed') {
    const data = {
      messageId: str(payload.messageId),
      conversationId,
      emoji: str(payload.emoji),
      userId: str(payload.userId),
      added: routingKey === 'chat.reaction.added',
    };
    // También a quien reaccionó (sus otras pestañas): en este evento el autor no se excluye de la lista.
    const to = new Set([...members, ...(str(payload.userId) ? [str(payload.userId)!] : [])]);
    plan.emits = [...to].map((u) => ({ room: userRoom(u), event: 'chat.reaction.changed', data }));
    return plan;
  }

  if (routingKey === 'chat.conversation.read') {
    const userId = str(payload.userId);
    if (!userId) return null;
    plan.emits = [{ room: userRoom(userId), event: 'chat.read', data: { conversationId, lastReadSeq: payload.lastReadSeq ?? null } }];
    return plan;
  }

  if (routingKey.startsWith('chat.conversation.') || routingKey.startsWith('chat.member.')) {
    const data = { event: routingKey, conversationId };
    const isPublic = payload.kind === 'channel' && payload.visibility === 'public';
    if (isPublic) {
      plan.emits.push({ room: `${orgRoomPrefix}${organizationId}`, event: 'chat.conversation.changed', data });
    } else {
      // Quien entró o salió también se entera (a quien quitan de un privado le desaparece de la barra).
      const to = new Set([...members, ...strings(payload.userIds)]);
      for (const u of to) plan.emits.push({ room: userRoom(u), event: 'chat.conversation.changed', data });
    }
    return plan;
  }

  return null;
}
