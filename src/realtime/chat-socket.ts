import type { Server as SocketServer, Socket } from 'socket.io';
import { z } from 'zod';
import type { ChatMembersCache } from './chat-members';

/**
 * Mensajería: lo que el navegador manda por el socket (contrato en `backend/chat-service/docs/tiempo-real.md`). Solo «escribiendo…» y
 * presencia: enviar, editar, reaccionar y leer van por REST (chat-service es la única fuente de verdad).
 *
 * Presencia en memoria del gateway. Una persona entra al registro cuando una pestaña del CRM se anuncia con `chat:activity`, no al
 * conectar: la caja (POS) también abre este socket con su propio `sub` y no debe salir «en línea» como si fuera alguien del equipo.
 * Con varias réplicas del gateway cada una vería solo sus sockets; hoy hay una (ver k8s/deployment.yaml). Al reiniciar, todos
 * reconectan, se vuelven a anunciar y la presencia se rehace sola.
 */
export type PresenceState = 'online' | 'away' | 'offline';

interface Entry {
  sockets: Set<string>;
  away: Set<string>;
}

export class PresenceRegistry {
  private readonly orgs = new Map<string, Map<string, Entry>>();

  state(orgId: string, userId: string): PresenceState {
    const e = this.orgs.get(orgId)?.get(userId);
    if (!e || e.sockets.size === 0) return 'offline';
    return e.away.size === e.sockets.size ? 'away' : 'online';
  }

  /** `@aquí`: solo avisa a quien está conectado y activo (como Slack). */
  isActive(orgId: string, userId: string): boolean {
    return this.state(orgId, userId) === 'online';
  }

  /** Una pestaña dice si está activa o ausente. Devuelve el estado agregado nuevo si cambió (para emitirlo), o null. */
  activity(orgId: string, userId: string, socketId: string, state: 'active' | 'away'): PresenceState | null {
    const before = this.state(orgId, userId);
    let users = this.orgs.get(orgId);
    if (!users) this.orgs.set(orgId, (users = new Map()));
    let e = users.get(userId);
    if (!e) users.set(userId, (e = { sockets: new Set(), away: new Set() }));
    e.sockets.add(socketId);
    if (state === 'away') e.away.add(socketId);
    else e.away.delete(socketId);
    const after = this.state(orgId, userId);
    return after === before ? null : after;
  }

  /** Se fue una pestaña. Devuelve el estado agregado nuevo si cambió; 'offline' lo emite quien llama tras la gracia. */
  disconnect(orgId: string, userId: string, socketId: string): PresenceState | null {
    const users = this.orgs.get(orgId);
    const e = users?.get(userId);
    if (!users || !e || !e.sockets.has(socketId)) return null;
    const before = this.state(orgId, userId);
    e.sockets.delete(socketId);
    e.away.delete(socketId);
    if (e.sockets.size === 0) {
      users.delete(userId);
      if (users.size === 0) this.orgs.delete(orgId);
    }
    const after = this.state(orgId, userId);
    return after === before ? null : after;
  }
}

export interface ChatSocketOptions {
  presence: PresenceRegistry;
  /** Sin miembros (falta `CHAT_SERVICE_URL`) no hay «escribiendo…»: no se puede saber a quién mandarlo sin filtrar conversaciones. */
  members?: ChatMembersCache;
  /** Gracia antes de emitir `offline`: una recarga de la página no hace parpadear el punto verde. */
  offlineGraceMs?: number;
  typingIntervalMs?: number;
  now?: () => number;
}

const ORG_ROOM = (orgId: string) => `catalog:${orgId}`;
const USER_ROOM = (userId: string) => `user:${userId}`;

const typingSchema = z.object({ conversationId: z.string().guid(), threadRootId: z.string().guid().nullish() });
const presenceSchema = z.object({ userIds: z.array(z.string().max(64)).max(200) });
const activitySchema = z.object({ state: z.enum(['active', 'away']) });

type Ack = (res: { ok: boolean; data?: unknown; message?: string }) => void;

export function registerChatSocket(io: SocketServer, options: ChatSocketOptions): void {
  const grace = options.offlineGraceMs ?? 30_000;
  const typingEvery = options.typingIntervalMs ?? 3_000;
  const now = options.now ?? Date.now;
  const { presence } = options;

  const announce = (orgId: string, userId: string, state: PresenceState) => io.to(ORG_ROOM(orgId)).emit('chat.presence', { userId, state });

  io.on('connection', (socket: Socket) => {
    const orgId = socket.data.organizationId as string;
    const userId = ((socket.data.subjectId as string | null) ?? '').toLowerCase();
    if (!orgId || !userId) return;
    const lastTyping = new Map<string, number>();

    socket.on('chat:activity', (payload: unknown, ack?: Ack) => {
      const p = activitySchema.safeParse(payload);
      if (!p.success) return ack?.({ ok: false, message: 'Estado inválido' });
      const changed = presence.activity(orgId, userId, socket.id, p.data.state);
      if (changed) announce(orgId, userId, changed);
      ack?.({ ok: true });
    });

    socket.on('chat:presence', (payload: unknown, ack?: Ack) => {
      const p = presenceSchema.safeParse(payload);
      if (!p.success) return ack?.({ ok: false, message: 'Lista inválida' });
      // El registro es por organización: de otra empresa nunca sale nada (todos «offline»).
      const data = Object.fromEntries(p.data.userIds.map((u) => [u, presence.state(orgId, u.toLowerCase())]));
      ack?.({ ok: true, data });
    });

    socket.on('chat:typing', (payload: unknown) => {
      const p = typingSchema.safeParse(payload);
      if (!p.success || !options.members) return;
      const { conversationId } = p.data;
      const threadRootId = p.data.threadRootId ?? null;
      const key = `${conversationId}:${threadRootId ?? ''}`;
      const t = now();
      const last = lastTyping.get(key);
      if (last !== undefined && t - last < typingEvery) return;
      lastTyping.set(key, t);
      void options.members.members(orgId, conversationId).then((ids) => {
        // Solo un miembro puede decir que escribe, y solo lo ven los demás miembros: no se filtra que existe un DM o un canal privado.
        if (!ids || !ids.has(userId)) return;
        for (const m of ids) if (m !== userId) io.to(USER_ROOM(m)).emit('chat.typing', { conversationId, threadRootId, userId });
      });
    });

    socket.on('disconnect', () => {
      const changed = presence.disconnect(orgId, userId, socket.id);
      if (!changed) return;
      if (changed !== 'offline') return void announce(orgId, userId, changed);
      setTimeout(() => {
        if (presence.state(orgId, userId) === 'offline') announce(orgId, userId, 'offline');
      }, grace).unref?.();
    });
  });
}
