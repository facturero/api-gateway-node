import type { ChatMemberSource } from './chat-client';

/**
 * Caché de miembros por conversación para el hub (contrato en `backend/chat-service/docs/tiempo-real.md`). «Escribiendo…» llega cada
 * pocos segundos por cada persona que teclea: sin caché sería una llamada a chat-service por pulsación. 30 s de vida y se invalida con
 * `chat.member.*` (quien sale de un canal deja de ver quién escribe al instante, no a los 30 s).
 *
 * Si chat-service no responde (`null`), no se guarda: el siguiente aviso lo vuelve a intentar.
 */
export class ChatMembersCache {
  private readonly entries = new Map<string, { at: number; ids: Set<string> }>();

  constructor(
    private readonly source: ChatMemberSource,
    private readonly ttlMs = 30_000,
    private readonly now: () => number = Date.now,
  ) {}

  async members(organizationId: string, conversationId: string): Promise<Set<string> | null> {
    const key = `${organizationId}:${conversationId}`;
    const hit = this.entries.get(key);
    if (hit && this.now() - hit.at < this.ttlMs) return hit.ids;
    const ids = await this.source.memberIds(organizationId, conversationId);
    if (!ids) return null;
    const set = new Set(ids.map((x) => x.toLowerCase()));
    this.entries.set(key, { at: this.now(), ids: set });
    // Tope de memoria: el gateway vive semanas; las conversaciones viejas salen por orden de llegada.
    if (this.entries.size > 5_000) this.entries.delete(this.entries.keys().next().value!);
    return set;
  }

  invalidate(organizationId: string, conversationId: string): void {
    this.entries.delete(`${organizationId}:${conversationId}`);
  }
}
