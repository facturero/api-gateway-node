import type { ClaimHeaderMapping } from './types';

export function buildContextHeaders(
  claims: Record<string, unknown> | undefined,
  mappings: ClaimHeaderMapping[],
): Record<string, string> {
  const headers: Record<string, string> = {};
  if (!claims) return headers;

  for (const { claim, header } of mappings) {
    const value = claims[claim];
    if (value !== undefined && value !== null) {
      headers[header] = String(value);
    }
  }

  return headers;
}

/**
 * Cabeceras que solo pueden venir de dentro del clúster. Un cliente que las
 * mande a través del gateway se hace pasar por un servicio: con
 * `X-Internal-Secret` (cuyo valor de desarrollo está en el repo) cualquier
 * usuario autenticado leía por `/files/:id/content` el .p12 de otra
 * organización. Comprobado contra el docker-compose el 2026-09-13.
 */
export const INTERNAL_ONLY_HEADERS = ['x-internal-secret'];

export function deriveSpoofHeaders(mappings: ClaimHeaderMapping[]): string[] {
  return [...mappings.map((m) => m.header.toLowerCase()), ...INTERNAL_ONLY_HEADERS];
}
