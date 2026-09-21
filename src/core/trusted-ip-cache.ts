/**
 * Cache en memoria de IPs confiables, refresh periódico desde auth-service.
 *
 * Flujo:
 *  1. Al iniciar intenta cargar de auth-service/trusted-ips/enabled
 *  2. Si falla, usa las IPs de RATE_LIMIT_TRUSTED_IPS (env var, fallback)
 *  3. Cada TRUSTED_IPS_REFRESH_MS (default 30s) re-fetch
 */

const DEFAULT_REFRESH_MS = 30_000;

interface TrustedIpEntry {
  ip: string;
}

export class TrustedIpCache {
  private ips: string[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private fetching = false;

  constructor(
    private authServiceUrl: string,
    private fallbackIps: string[] = [],
    private refreshMs: number = DEFAULT_REFRESH_MS,
  ) {}

  /** Carga inicial + arranca timer. */
  async start(): Promise<void> {
    await this.refresh();
    this.timer = setInterval(() => {
      this.refresh().catch(() => {});
    }, this.refreshMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  getTrustedIps(): string[] {
    return this.ips;
  }

  private async refresh(): Promise<void> {
    if (this.fetching) return;
    this.fetching = true;
    try {
      const url = `${this.authServiceUrl}/trusted-ips/enabled`;
      const res = await fetch(url, {
        headers: { 'Accept': 'application/json' },
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as TrustedIpEntry[];
      const fetched = data.map((e) => e.ip);
      // Unión en lugar de reemplazo: la lista de DB de auth-service NO debe
      // pisar el fallback de env (RATE_LIMIT_TRUSTED_IPS). Si la DB devuelve
      // una lista que no incluye una IP del env (p. ej. la del generador de
      // stress), reemplazar la dejaba fuera y el rate-limit volvía a 429
      // contra ella incluso estando configurada para siempre en el env.
      // Dedupe conservando el orden: primero lo de la DB, luego el fallback.
      this.ips = [...new Set([...fetched, ...this.fallbackIps])];
      console.log(
        `[trusted-ip-cache] ${fetched.length} IPs cargadas desde auth-service` +
          (fetched.length === 0 ? ` (usando fallback: ${this.fallbackIps.length} IPs)` : ''),
      );
    } catch (err) {
      if (this.ips.length === 0) {
        this.ips = [...this.fallbackIps];
        console.warn(`[trusted-ip-cache] fallback a env: ${this.ips.length} IPs`);
      } else {
        console.warn(`[trusted-ip-cache] refresh falló, usando cache anterior (${this.ips.length} IPs)`);
      }
    } finally {
      this.fetching = false;
    }
  }
}
