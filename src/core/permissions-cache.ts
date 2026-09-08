/**
 * Cache del permissions-version (pv) por usuario para el chequeo de tokens stale.
 *
 * El gateway valida en cada ruta no-pública que el `pv` del JWT coincide con el
 * `pv` actual del usuario (fuente: auth-service `users.permissions_version`).
 * Consultar auth-service en CADA request sería caro, así que cacheamos con un
 * TTL corto (10s) y fail-open:
 *   - si auth-service no responde, usamos el valor cacheado (aunque esté
 *     vencido) o `null` (confiar en el token) — nunca rompemos el API por una
 *     caída puntual del chequeo.
 *   - los eventos `identity.#` (role.updated, user.disabled/enabled, ...)
 *     invalidan la caché al instante (hub.ts), con lo que el cambio de
 *     permisos surte efecto en la siguiente request del usuario afectado.
 *
 * BUG #9.
 */

const TTL_MS = 10_000;

interface Entry {
  pv: number;
  fetchedAt: number;
}

export class PermissionsVersionCache {
  private entries = new Map<string, Entry>();
  private inflight = new Map<string, Promise<number | null>>();

  constructor(
    private authServiceUrl: string,
    private internalSecret: string | undefined,
  ) {}

  /**
   * Devuelve el pv actual del usuario, o `null` si no hay información utilizable
   * (auth-service caído y sin cache previa). El caller trata `null` como
   * "confiar en el token" (fail-open).
   */
  async getPv(userId: string): Promise<number | null> {
    const cached = this.entries.get(userId);
    if (cached && Date.now() - cached.fetchedAt < TTL_MS) return cached.pv;

    const pending = this.inflight.get(userId) ?? this.fetch(userId);
    this.inflight.set(userId, pending);
    try {
      return await pending;
    } finally {
      this.inflight.delete(userId);
    }
  }

  /** Invalida la entrada de un usuario (invocado desde los eventos identity.#). */
  invalidate(userId: string): void {
    this.entries.delete(userId);
  }

  /**
   * Fuerza la consulta a auth-service ignorando la entrada cacheada (aunque esté
   * dentro del TTL). Se usa para RECONFIRMAR un rechazo por TOKEN_STALE: la caché
   * puede quedarse con un pv viejo si un request la pobló justo antes de que el
   * mismo request subiera el pv (complete-profil crea la organización y bump).
   */
  async getPvFresh(userId: string): Promise<number | null> {
    return this.fetch(userId);
  }

  private async fetch(userId: string): Promise<number | null> {
    try {
      if (!this.internalSecret) return this.fallback(userId);
      const url = `${this.authServiceUrl}/internal/users/${encodeURIComponent(userId)}/access-context`;
      const res = await fetch(url, {
        headers: { 'X-Internal-Secret': this.internalSecret, 'Accept': 'application/json' },
        signal: AbortSignal.timeout(3000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as { pv?: number };
      const pv = Number(data.pv ?? 0);
      this.entries.set(userId, { pv, fetchedAt: Date.now() });
      return pv;
    } catch (err) {
      console.warn(`[permissions-cache] no se pudo obtener pv de ${userId}, fail-open:`, err);
      return this.fallback(userId);
    }
  }

  private fallback(userId: string): number | null {
    const cached = this.entries.get(userId);
    return cached ? cached.pv : null;
  }
}