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

export function deriveSpoofHeaders(mappings: ClaimHeaderMapping[]): string[] {
  return mappings.map((m) => m.header.toLowerCase());
}
