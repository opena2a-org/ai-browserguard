import { describe, it, expect, vi, beforeEach } from 'vitest';
import { lookupAgentIdentity, clearAIMCache, getAIMCacheSize } from './client';

// Mock global fetch
const mockFetch = vi.fn();
(globalThis as Record<string, unknown>).fetch = mockFetch;

beforeEach(() => {
  clearAIMCache();
  mockFetch.mockReset();
});

describe('lookupAgentIdentity', () => {
  it('returns status=ok with trust score on successful lookup', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.resolve({
        trustScore: 0.85,
        displayName: 'Verified Playwright',
        name: 'playwright',
      }),
    });

    const result = await lookupAgentIdentity('playwright', 'https://example.com', {
      baseUrl: 'https://aim.test',
    });

    expect(result.status).toBe('ok');
    if (result.status === 'ok') {
      expect(result.trustScore).toBe(0.85);
      expect(result.label).toBe('Verified Playwright');
      expect(result.registered).toBe(true);
    }
    expect(mockFetch).toHaveBeenCalledOnce();
    expect(mockFetch.mock.calls[0][0]).toContain('aim.test');
    expect(mockFetch.mock.calls[0][0]).toContain('/api/v1/sdk-api/agents/playwright');
  });

  it('returns status=unregistered on 404', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 404,
    });

    const result = await lookupAgentIdentity('unknown-agent', 'https://example.com');
    expect(result.status).toBe('unregistered');
    if (result.status === 'unregistered') {
      expect(result.label).toBe('unknown-agent');
      expect(result.registered).toBe(false);
    }
  });

  it('returns status=unreachable on non-200/non-404 response', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
    });

    const result = await lookupAgentIdentity('playwright', 'https://example.com');
    expect(result.status).toBe('unreachable');
  });

  it('returns status=unreachable on network error', async () => {
    mockFetch.mockRejectedValueOnce(new Error('Network error'));

    const result = await lookupAgentIdentity('playwright', 'https://example.com');
    expect(result.status).toBe('unreachable');
  });

  it('returns status=unreachable on AbortSignal timeout', async () => {
    mockFetch.mockRejectedValueOnce(Object.assign(new Error('aborted'), { name: 'AbortError' }));
    const result = await lookupAgentIdentity('playwright', 'https://example.com');
    expect(result.status).toBe('unreachable');
  });

  it('caches results for the same agent+origin', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.resolve({
        trustScore: 0.9,
        displayName: 'Test',
        name: 'playwright',
      }),
    });

    const result1 = await lookupAgentIdentity('playwright', 'https://example.com');
    const result2 = await lookupAgentIdentity('playwright', 'https://example.com');

    expect(result1).toEqual(result2);
    expect(mockFetch).toHaveBeenCalledOnce(); // Only one fetch, second was cached
    expect(getAIMCacheSize()).toBe(1);
  });

  it('uses different cache keys for different agents', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({
        trustScore: 0.5,
        displayName: 'Agent',
        name: 'agent',
      }),
    });

    await lookupAgentIdentity('playwright', 'https://a.com');
    await lookupAgentIdentity('puppeteer', 'https://a.com');

    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(getAIMCacheSize()).toBe(2);
  });

  it('handles malformed response data gracefully', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.resolve({
        // Missing expected fields
        unexpected: 'data',
      }),
    });

    const result = await lookupAgentIdentity('selenium', 'https://example.com');
    expect(result.status).toBe('ok');
    if (result.status === 'ok') {
      expect(result.trustScore).toBe(0);
      expect(result.label).toBe('selenium');
      expect(result.registered).toBe(true); // 200 means registered
    }
  });

  it('falls back to name when displayName is missing', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.resolve({
        trustScore: 0.7,
        name: 'my-agent',
      }),
    });

    const result = await lookupAgentIdentity('my-agent', 'https://example.com');
    expect(result.status).toBe('ok');
    if (result.status === 'ok') {
      expect(result.label).toBe('my-agent');
    }
  });

  it('clears cache when clearAIMCache is called', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({
        trustScore: 0.5,
        displayName: 'Test',
        name: 'playwright',
      }),
    });

    await lookupAgentIdentity('playwright', 'https://example.com');
    expect(getAIMCacheSize()).toBe(1);

    clearAIMCache();
    expect(getAIMCacheSize()).toBe(0);
  });

  it('re-fetches after cache is cleared', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({
        trustScore: 0.5,
        displayName: 'Test',
        name: 'playwright',
      }),
    });

    await lookupAgentIdentity('playwright', 'https://example.com');
    clearAIMCache();
    await lookupAgentIdentity('playwright', 'https://example.com');

    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('caches 404 results to avoid repeated lookups', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 404,
    });

    const result1 = await lookupAgentIdentity('missing', 'https://example.com');
    const result2 = await lookupAgentIdentity('missing', 'https://example.com');

    expect(result1).toEqual(result2);
    expect(result1.status).toBe('unregistered');
    expect(mockFetch).toHaveBeenCalledOnce();
  });

  it('does NOT cache unreachable results so transient failures are retried', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 500 });
    const first = await lookupAgentIdentity('retry-me', 'https://example.com');
    expect(first.status).toBe('unreachable');

    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ trustScore: 0.4, displayName: 'Retry', name: 'retry-me' }),
    });
    const second = await lookupAgentIdentity('retry-me', 'https://example.com');
    expect(second.status).toBe('ok');
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  // ---------------------------------------------------------------------
  // Regression: P0-3a — AIM client must reject non-HTTPS base URLs in
  // production. A plaintext or attacker-controlled endpoint returning
  // trustScore: 1.0 would bypass detection escalation.
  // ---------------------------------------------------------------------
  describe('base URL validation', () => {
    it('returns status=unreachable for http://hostile.example.com without making a fetch', async () => {
      const result = await lookupAgentIdentity('playwright', 'https://example.com', {
        baseUrl: 'http://hostile.example.com',
      });
      expect(result.status).toBe('unreachable');
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('returns status=unreachable for ftp:// and javascript: schemes', async () => {
      const ftp = await lookupAgentIdentity('playwright', 'https://example.com', {
        baseUrl: 'ftp://aim.opena2a.org',
      });
      expect(ftp.status).toBe('unreachable');
      const jsScheme = await lookupAgentIdentity('playwright', 'https://example.com', {
        baseUrl: 'javascript:alert(1)',
      });
      expect(jsScheme.status).toBe('unreachable');
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('permits http://localhost in the test environment (NODE_ENV=test)', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ trustScore: 0.5, displayName: 'Local', name: 'p' }),
      });
      const result = await lookupAgentIdentity('p', 'https://example.com', {
        baseUrl: 'http://localhost:8080',
      });
      expect(result.status).toBe('ok');
      expect(mockFetch).toHaveBeenCalledOnce();
    });

    it('uses https://aim.opena2a.org when no baseUrl option is provided', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ trustScore: 0.5, displayName: 'A', name: 'a' }),
      });
      await lookupAgentIdentity('a', 'https://example.com');
      expect(mockFetch).toHaveBeenCalledOnce();
      const calledUrl = String(mockFetch.mock.calls[0][0]);
      expect(calledUrl.startsWith('https://aim.opena2a.org/')).toBe(true);
    });
  });
});
