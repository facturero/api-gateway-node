import type { RouteRule } from './types';

export function matchRoute(
  routes: RouteRule[],
  method: string,
  pathname: string,
): RouteRule | undefined {
  for (const rule of routes) {
    if (rule.method !== 'ANY' && rule.method !== method) continue;
    if (matchPath(rule.path, pathname)) return rule;
  }
  return undefined;
}

function matchPath(pattern: string, pathname: string): boolean {
  if (pattern.endsWith('/*')) {
    const prefix = pattern.slice(0, -2);
    return pathname === prefix || pathname.startsWith(prefix + '/');
  }
  return pattern === pathname;
}
