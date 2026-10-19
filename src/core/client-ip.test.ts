import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { clientIp } from './create-gateway';
import { buildTargetUrl } from './proxy';

// getConnInfo lee el socket del entorno de Node; aquí se simula.
const env = { incoming: { socket: { remoteAddress: '::ffff:10.0.0.5', remotePort: 5000, remoteFamily: 'IPv6' } } };
const app = new Hono().get('/ip', (c) => c.text(clientIp(c)));
const ip = async (headers: Record<string, string> = {}) => (await app.request('/ip', { headers }, env)).text();

describe('clientIp', () => {
  it('prefiere cf-connecting-ip, que fija Cloudflare', async () => {
    expect(await ip({ 'cf-connecting-ip': '198.51.100.9', 'x-forwarded-for': '1.2.3.4, 198.51.100.9' })).toBe('198.51.100.9');
  });

  it('de x-forwarded-for usa el último salto, no el primero (que lo escribe el cliente)', async () => {
    expect(await ip({ 'x-forwarded-for': '1.2.3.4, 198.51.100.9' })).toBe('198.51.100.9');
  });

  it('sin cabeceras de proxy usa la IP del socket desmapeada', async () => {
    expect(await ip()).toBe('10.0.0.5');
  });
});

describe('buildTargetUrl', () => {
  it('un path con // no cambia el host del servicio', () => {
    const url = buildTargetUrl('http://billing-service:3009', '//evil.example/x', '?a=1');
    expect(url.host).toBe('billing-service:3009');
    expect(url.toString()).toBe('http://billing-service:3009/evil.example/x?a=1');
  });

  it('conserva path y query normales', () => {
    expect(buildTargetUrl('http://svc:1', '/v1/traces', '').toString()).toBe('http://svc:1/v1/traces');
  });
});
