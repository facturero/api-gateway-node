/**
 * Gate del canal `app` (campana realtime) para eventos de notificación.
 *
 * El notification-service expone el catálogo de providers (qué eventos son
 * notificables y el `app` por defecto) y las preferencias efectivas por usuario
 * (`GET /me/preferences`, endpoint service-to-service: el gateway inyecta el
 * `X-User-Id` del payload del evento, mismo header que usa para los claims del
 * JWT). Aquí cacheamos:
 *   - catálogo de providers (TTL 60s): qué providers tienen canal `app`.
 *   - preferencias del usuario (TTL 30s): overrides por provider.
 *
 * El canal `app` entrega la campana: si la preferencia real dice "off", la
 * campana no suena (a lo Moodle: el usuario desactivó la notificación para ese
 * plugin/evento). Si el evento no es notificable, `isAppEnabled` = false.
 * Fail-open: si el notification-service no responde, se emite igualmente
 * (una campana de más es menos grave que perderse una notificación).
 */
export interface NotificationGate {
  isAppEnabled(userId: string, providerCode: string): Promise<boolean>;
}

interface ProviderInfo {
  hasApp: boolean;
  appDefault: boolean;
}

export class HttpNotificationGate implements NotificationGate {
  private catalogCache: { at: number; providers: Map<string, ProviderInfo> } | null = null;
  private userCache = new Map<string, { at: number; app: Map<string, boolean> }>();

  constructor(
    private readonly baseUrl: string,
    private readonly catalogTtlMs = 60_000,
    private readonly userTtlMs = 30_000,
  ) {}

  async isAppEnabled(userId: string, providerCode: string): Promise<boolean> {
    try {
      const providers = await this.loadCatalog();
      const provider = providers.get(providerCode);
      // Si el evento NO es provider de notificaciones (p.ej. identity.role.updated),
      // no hay campana: false. El flujo `permissions.changed` sigue siendo siempre.
      if (!provider || !provider.hasApp) return false;

      const userPrefs = await this.loadUserPreferences(userId);
      if (userPrefs.has(providerCode)) return userPrefs.get(providerCode)!;
      return provider.appDefault;
    } catch (err) {
      console.error(
        `[notification-gate] fallback a emitir (fail-open) para ${providerCode} (${userId}):`,
        err,
      );
      return true;
    }
  }

  private async loadCatalog(): Promise<Map<string, ProviderInfo>> {
    if (this.catalogCache && Date.now() - this.catalogCache.at < this.catalogTtlMs) {
      return this.catalogCache.providers;
    }
    const res = await fetch(`${this.baseUrl}/notifications/providers`);
    if (!res.ok) throw new Error(`providers ${res.status}`);
    const body = (await res.json()) as { providers: Array<{ code: string; channels: string[]; defaults: { app?: boolean } }> };
    const providers = new Map<string, ProviderInfo>();
    for (const p of body.providers) {
      providers.set(p.code, {
        hasApp: p.channels.includes('app'),
        appDefault: p.defaults.app === true,
      });
    }
    this.catalogCache = { at: Date.now(), providers };
    return providers;
  }

  private async loadUserPreferences(userId: string): Promise<Map<string, boolean>> {
    const cached = this.userCache.get(userId);
    if (cached && Date.now() - cached.at < this.userTtlMs) return cached.app;

    const res = await fetch(`${this.baseUrl}/notifications/me/preferences`, {
      headers: { 'X-User-Id': userId },
    });
    if (!res.ok) throw new Error(`preferences ${res.status}`);
    const body = (await res.json()) as { preferences: Array<{ providerCode: string; channels: { app: boolean } }> };
    const app = new Map<string, boolean>();
    for (const p of body.preferences) {
      app.set(p.providerCode, p.channels.app);
    }
    this.userCache.set(userId, { at: Date.now(), app });
    return app;
  }
}