import { describe, expect, it } from 'vitest';
import { resolveClientIp } from '@toran/security';
import { clientAddressClaim } from '@/server/http';

/**
 * Per-client rate limits and the anonymous upload quota are only as sound as
 * the client identity behind them. Next.js never exposes the TCP peer, so that
 * identity comes from request headers, which the caller writes.
 *
 * These pin the rule that makes the limits mean anything: the headers are read
 * only when the deployment has named the proxy that overwrites them.
 */
const request = (headers: Record<string, string>): Request =>
  new Request('https://toran.example/api/uploads', { method: 'POST', headers });

const resolve = (headers: Record<string, string>, trustedProxies: readonly string[]): string =>
  resolveClientIp(clientAddressClaim(request(headers), trustedProxies));

describe('client identity with no proxy declared', () => {
  it('ignores X-Real-IP, which any caller can set', () => {
    expect(resolve({ 'x-real-ip': '203.0.113.9' }, [])).toBe('unknown');
  });

  it('ignores X-Forwarded-For too', () => {
    expect(resolve({ 'x-forwarded-for': '203.0.113.9' }, [])).toBe('unknown');
  });

  it('ignores the Vercel variant', () => {
    expect(resolve({ 'x-vercel-ip': '203.0.113.9' }, [])).toBe('unknown');
  });

  it('gives every caller the same identity, so none of them can mint a fresh budget', () => {
    const first = resolve({ 'x-real-ip': '203.0.113.1' }, []);
    const second = resolve({ 'x-real-ip': '198.51.100.2' }, []);
    const third = resolve({}, []);
    expect(first).toBe(second);
    expect(second).toBe(third);
  });
});

describe('client identity with a proxy declared', () => {
  const proxies = ['10.0.0.0/8'];

  it('reads the address the proxy asserts', () => {
    expect(resolve({ 'x-real-ip': '203.0.113.9' }, proxies)).toBe('203.0.113.9');
  });

  it('separates callers, so each carries its own budget', () => {
    expect(resolve({ 'x-real-ip': '203.0.113.1' }, proxies)).not.toBe(
      resolve({ 'x-real-ip': '198.51.100.2' }, proxies),
    );
  });

  it('takes the right-most untrusted hop when the peer is the proxy itself', () => {
    expect(
      resolve({ 'x-real-ip': '10.0.0.1', 'x-forwarded-for': '1.1.1.1, 203.0.113.9' }, proxies),
    ).toBe('203.0.113.9');
  });

  it('falls back to a shared identity when the proxy sends nothing', () => {
    expect(resolve({}, proxies)).toBe('unknown');
  });
});
