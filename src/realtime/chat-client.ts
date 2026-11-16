/**
 * Cliente interno de chat-service para el hub: trae el mensaje completo que los eventos no llevan (regla 10 de chat-service). Llamada
 * DIRECTA al servicio (no por el gateway) con `X-Internal-Secret`. Si falla, devuelve null y el hub manda el aviso mínimo: el navegador
 * lo pide por REST con su sesión.
 */
export interface ChatMessageSource {
  getMessage(organizationId: string, messageId: string): Promise<Record<string, unknown> | null>;
}

export class HttpChatMessageSource implements ChatMessageSource {
  constructor(private readonly baseUrl: string, private readonly secret: string) {}

  async getMessage(organizationId: string, messageId: string): Promise<Record<string, unknown> | null> {
    try {
      const res = await fetch(`${this.baseUrl}/internal/messages/${encodeURIComponent(messageId)}?organizationId=${encodeURIComponent(organizationId)}`, {
        headers: { 'X-Internal-Secret': this.secret, Accept: 'application/json' },
        signal: AbortSignal.timeout(3_000),
      });
      if (!res.ok) {
        console.warn(`[realtime] chat-service respondió ${res.status} al pedir el mensaje ${messageId}`);
        return null;
      }
      return (await res.json()) as Record<string, unknown>;
    } catch (err) {
      console.warn(`[realtime] no se pudo pedir el mensaje ${messageId} a chat-service:`, err);
      return null;
    }
  }
}

/** Miembros de una conversación, para «escribiendo…» (`GET /internal/conversations/:id/members`). null = no se pudo saber. */
export interface ChatMemberSource {
  memberIds(organizationId: string, conversationId: string): Promise<string[] | null>;
}

export class HttpChatMemberSource implements ChatMemberSource {
  constructor(private readonly baseUrl: string, private readonly secret: string) {}

  async memberIds(organizationId: string, conversationId: string): Promise<string[] | null> {
    try {
      const res = await fetch(
        `${this.baseUrl}/internal/conversations/${encodeURIComponent(conversationId)}/members?organizationId=${encodeURIComponent(organizationId)}`,
        { headers: { 'X-Internal-Secret': this.secret, Accept: 'application/json' }, signal: AbortSignal.timeout(3_000) },
      );
      // 404 = no existe en esa organización: nadie es miembro (no se reintenta en cada tecla).
      if (res.status === 404) return [];
      if (!res.ok) return null;
      const body = (await res.json()) as { userIds?: unknown };
      return Array.isArray(body.userIds) ? body.userIds.filter((x): x is string => typeof x === 'string') : [];
    } catch {
      return null;
    }
  }
}
