/**
 * Cache en memoria de los plugins activos por organización.
 *
 * El gateway necesita saber, en cada request, si la organización tiene activo
 * el plugin que la ruta exige. Preguntárselo a plugin-catalog en cada petición
 * añadiría un salto de red por request, así que se cachea por organización con
 * un TTL corto y se invalida en cuanto llega un evento `plugin.*` por RabbitMQ
 * (ver realtime/hub.ts): activar o desactivar se refleja al instante y el TTL
 * solo cubre el caso de que el evento se pierda.
 *
 * Ante un fallo de plugin-catalog se sirve la entrada vencida si existe: una
 * caída del catálogo no debe apagarle los módulos a quien ya los tenía.
 */

const DEFAULT_TTL_MS = 60_000;
const FETCH_TIMEOUT_MS = 5_000;

interface Entry {
  codes: Set<string>;
  expiresAt: number;
}

interface OrganizationPluginRow {
  pluginCode?: string;
  status: 'active' | 'disabled';
}

export class PluginActivationCache {
  private entries = new Map<string, Entry>();
  private inflight = new Map<string, Promise<Set<string>>>();

  constructor(
    private readonly pluginCatalogUrl: string,
    private readonly ttlMs: number = DEFAULT_TTL_MS,
  ) {}

  /** Llamado desde el hub cuando llega un evento `plugin.*` de esa organización. */
  invalidate(organizationId: string): void {
    this.entries.delete(organizationId);
  }

  async isActive(organizationId: string, pluginCode: string): Promise<boolean> {
    const codes = await this.activeCodes(organizationId);
    return codes.has(pluginCode);
  }

  private async activeCodes(organizationId: string): Promise<Set<string>> {
    const cached = this.entries.get(organizationId);
    if (cached && cached.expiresAt > Date.now()) return cached.codes;

    // Coalesce: varias peticiones simultáneas de la misma org comparten el fetch.
    const pending = this.inflight.get(organizationId);
    if (pending) return pending;

    const promise = this.fetchActiveCodes(organizationId)
      .then((codes) => {
        this.entries.set(organizationId, { codes, expiresAt: Date.now() + this.ttlMs });
        return codes;
      })
      .catch((err: unknown) => {
        if (cached) {
          console.warn(
            `[plugin-activation-cache] refresh falló para ${organizationId}, se sirve cache vencida`,
          );
          return cached.codes;
        }
        throw err;
      })
      .finally(() => {
        this.inflight.delete(organizationId);
      });

    this.inflight.set(organizationId, promise);
    return promise;
  }

  private async fetchActiveCodes(organizationId: string): Promise<Set<string>> {
    const res = await fetch(`${this.pluginCatalogUrl}/organizations/me/plugins`, {
      headers: { Accept: 'application/json', 'X-Organization-Id': organizationId },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const rows = (await res.json()) as OrganizationPluginRow[];
    return new Set(
      rows
        .filter((r) => r.status === 'active' && r.pluginCode)
        .map((r) => r.pluginCode as string),
    );
  }
}
