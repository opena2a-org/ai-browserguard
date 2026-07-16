import { describe, it, expect, vi, beforeEach } from 'vitest';
import { lookupAiSafetyDeclaration, declarationOriginFor } from './client';
import { clearAiSafetyCache } from './cache';
import { updateSettings } from '../session/storage';

const mockFetch = vi.fn();
(globalThis as Record<string, unknown>).fetch = mockFetch;

beforeEach(async () => {
  await clearAiSafetyCache();
  mockFetch.mockReset();
  // The feature is default OFF, so every test below opts in first. The
  // default-OFF path itself is covered under "the opt-in gate" and in
  // src/__tests__/fresh-install-zero-network.test.ts.
  await updateSettings({ aiSafetyTxtEnabled: true });
});

const DECLARATION = 'AI-Safe: true\nInjection-Protected: false\nContact: mailto:a@b.com\n';

/** A response mock with no `body` stream, exercising the `text()` fallback. */
function textResponse(
  body: string,
  init?: { status?: number; contentType?: string | null; contentLength?: string },
): unknown {
  const headers = new Headers();
  const contentType = init?.contentType === undefined ? 'text/plain; charset=utf-8' : init.contentType;
  if (contentType !== null) headers.set('content-type', contentType);
  if (init?.contentLength !== undefined) headers.set('content-length', init.contentLength);
  const status = init?.status ?? 200;
  return {
    type: 'basic',
    ok: status >= 200 && status < 300,
    status,
    headers,
    body: null,
    text: () => Promise.resolve(body),
  };
}

/** A response mock backed by a real ReadableStream, exercising the capped reader. */
function streamResponse(chunks: Uint8Array[], contentLength?: string): unknown {
  const headers = new Headers({ 'content-type': 'text/plain' });
  if (contentLength !== undefined) headers.set('content-length', contentLength);
  return {
    type: 'basic',
    ok: true,
    status: 200,
    headers,
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(chunk);
        controller.close();
      },
    }),
    text: () => Promise.reject(new Error('text() must not be used when a stream is available')),
  };
}

describe('the opt-in gate', () => {
  it('makes no request when the feature is off', async () => {
    await updateSettings({ aiSafetyTxtEnabled: false });
    const result = await lookupAiSafetyDeclaration('https://example.com/page');

    expect(mockFetch).not.toHaveBeenCalled();
    // `unreachable`, not `none`: the setting means "do not contact this site",
    // which tells us nothing about whether it publishes a declaration.
    expect(result).toEqual({ status: 'unreachable' });
  });

  it('DOES request once opted in (proves the gate is not inverted)', async () => {
    // The companion to the test above. A refactor that inverted the gate would
    // pass one of these and fail the other; neither alone has teeth.
    await updateSettings({ aiSafetyTxtEnabled: true });
    mockFetch.mockResolvedValueOnce(textResponse(DECLARATION));

    const result = await lookupAiSafetyDeclaration('https://example.com/page');
    expect(mockFetch).toHaveBeenCalledOnce();
    expect(result.status).toBe('ok');
  });

  it('fails closed when the setting cannot be read', async () => {
    const get = chrome.storage.local.get as unknown as ReturnType<typeof vi.fn>;
    const original = get.getMockImplementation();
    get.mockRejectedValueOnce(new Error('storage unavailable'));
    try {
      // An unreadable setting is not consent.
      const result = await lookupAiSafetyDeclaration('https://example.com/page');
      expect(mockFetch).not.toHaveBeenCalled();
      expect(result).toEqual({ status: 'unreachable' });
    } finally {
      if (original) get.mockImplementation(original);
    }
  });

  it('writes nothing to the cache while off', async () => {
    await updateSettings({ aiSafetyTxtEnabled: false });
    await lookupAiSafetyDeclaration('https://example.com/page');
    const stored = await chrome.storage.local.get('aiSafetyDeclarationCache');
    expect(stored.aiSafetyDeclarationCache).toBeUndefined();
  });
});

describe('declarationOriginFor', () => {
  it('reduces a page URL to its origin', () => {
    expect(declarationOriginFor('https://example.com/deep/path?q=1#frag')).toBe('https://example.com');
  });

  it('keeps a non-default port', () => {
    expect(declarationOriginFor('https://example.com:8443/x')).toBe('https://example.com:8443');
  });

  it('strips userinfo', () => {
    expect(declarationOriginFor('https://user:pass@example.com/x')).toBe('https://example.com');
  });

  it.each([
    ['an http page', 'http://example.com/'],
    ['an extension page', 'chrome-extension://abc/popup.html'],
    ['a local file', 'file:///Users/x/page.html'],
    ['about:blank', 'about:blank'],
    ['a data URL', 'data:text/html,<h1>x</h1>'],
    ['garbage', 'not a url'],
    ['the empty string', ''],
  ])('refuses to derive an origin for %s', (_label, url) => {
    expect(declarationOriginFor(url)).toBeNull();
  });

  it('is not fooled by a userinfo-embedded host', () => {
    // A naive startsWith('https://localhost') check would pass this; it resolves
    // to attacker.com. Same reasoning as aim/client.ts:48.
    expect(declarationOriginFor('https://localhost@attacker.com/x')).toBe('https://attacker.com');
  });
});

describe('successful lookup', () => {
  it('returns the parsed declaration', async () => {
    mockFetch.mockResolvedValueOnce(textResponse(DECLARATION));
    const result = await lookupAiSafetyDeclaration('https://example.com/page');

    expect(result).toEqual({
      status: 'ok',
      declaration: { aiSafe: true, injectionProtected: false, contact: 'mailto:a@b.com' },
    });
  });

  it('requests exactly the well-known path on the page origin', async () => {
    mockFetch.mockResolvedValueOnce(textResponse(DECLARATION));
    await lookupAiSafetyDeclaration('https://example.com/deep/path?q=secret#frag');

    // The page path, query, and fragment must not appear in the request: they
    // are the parts that would actually reveal something the origin's log does
    // not already hold.
    expect(mockFetch.mock.calls[0][0]).toBe('https://example.com/.well-known/ai-safety.txt');
  });
});

describe('the request is pinned (ADR-009 section 2)', () => {
  it('sends no cookies, follows no redirect, leaks no referrer', async () => {
    mockFetch.mockResolvedValueOnce(textResponse(DECLARATION));
    await lookupAiSafetyDeclaration('https://example.com/page');

    const init = mockFetch.mock.calls[0][1];
    // Cookies would let the origin tie the declaration check to the user's
    // logged-in account, turning a weak fingerprint into an identified one.
    expect(init.credentials).toBe('omit');
    // A followed redirect could hand a third origin the request.
    expect(init.redirect).toBe('manual');
    expect(init.referrerPolicy).toBe('no-referrer');
    expect(init.method).toBe('GET');
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });
});

describe('non-HTTPS and unusable page URLs make no request at all', () => {
  it.each([
    ['http', 'http://example.com/page'],
    ['chrome-extension', 'chrome-extension://abc/popup.html'],
    ['file', 'file:///tmp/x.html'],
    ['garbage', 'nonsense'],
  ])('does not fetch for %s and reports unreachable', async (_label, url) => {
    const result = await lookupAiSafetyDeclaration(url);
    // `unreachable`, not `none`: the domain may publish a declaration, we simply
    // declined to read it. Reporting `none` would assert something false.
    expect(result).toEqual({ status: 'unreachable' });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('does not silently upgrade an http page to https', async () => {
    await lookupAiSafetyDeclaration('http://example.com/page');
    // Upgrading would contact an origin the agent never loaded.
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

describe('response classification', () => {
  it('reports none on 404', async () => {
    mockFetch.mockResolvedValueOnce(textResponse('', { status: 404 }));
    expect(await lookupAiSafetyDeclaration('https://example.com/')).toEqual({ status: 'none' });
  });

  it('reports none on 410', async () => {
    mockFetch.mockResolvedValueOnce(textResponse('', { status: 410 }));
    expect(await lookupAiSafetyDeclaration('https://example.com/')).toEqual({ status: 'none' });
  });

  it('reports none on an opaque redirect without following it', async () => {
    mockFetch.mockResolvedValueOnce({
      type: 'opaqueredirect',
      ok: false,
      status: 0,
      headers: new Headers(),
      body: null,
      text: () => Promise.resolve(''),
    });
    expect(await lookupAiSafetyDeclaration('https://example.com/')).toEqual({ status: 'none' });
    // One request, to the original origin. Nothing followed anywhere.
    expect(mockFetch).toHaveBeenCalledOnce();
  });

  it('reports none on a 301 status', async () => {
    mockFetch.mockResolvedValueOnce(textResponse('', { status: 301 }));
    expect(await lookupAiSafetyDeclaration('https://example.com/')).toEqual({ status: 'none' });
  });

  it.each([500, 502, 503, 403, 429])('reports unreachable on %i', async (status) => {
    mockFetch.mockResolvedValueOnce(textResponse('', { status }));
    // Transient-capable, so it must not be recorded as "publishes no declaration".
    expect(await lookupAiSafetyDeclaration('https://example.com/')).toEqual({ status: 'unreachable' });
  });

  it('reports unreachable on a network error', async () => {
    mockFetch.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    expect(await lookupAiSafetyDeclaration('https://example.com/')).toEqual({ status: 'unreachable' });
  });

  it('reports unreachable on a timeout', async () => {
    mockFetch.mockRejectedValueOnce(new DOMException('The operation timed out.', 'TimeoutError'));
    expect(await lookupAiSafetyDeclaration('https://example.com/')).toEqual({ status: 'unreachable' });
  });
});

describe('content-type is enforced', () => {
  it('rejects an HTML SPA fallback served at the well-known path', async () => {
    // The likeliest real-world false positive: a 200 with the site's app shell.
    mockFetch.mockResolvedValueOnce(
      textResponse('<!doctype html><html>AI-Safe: true</html>', { contentType: 'text/html' }),
    );
    expect(await lookupAiSafetyDeclaration('https://example.com/')).toEqual({ status: 'none' });
  });

  it('rejects a missing content-type', async () => {
    mockFetch.mockResolvedValueOnce(textResponse(DECLARATION, { contentType: null }));
    expect(await lookupAiSafetyDeclaration('https://example.com/')).toEqual({ status: 'none' });
  });

  it.each([
    'text/plain',
    'text/plain; charset=utf-8',
    'TEXT/PLAIN',
    'text/plain ; charset=iso-8859-1',
  ])('accepts the media type %j', async (contentType) => {
    mockFetch.mockResolvedValueOnce(textResponse(DECLARATION, { contentType }));
    const result = await lookupAiSafetyDeclaration('https://example.com/');
    expect(result.status).toBe('ok');
  });

  it('rejects text/plain smuggled as a parameter of another type', async () => {
    mockFetch.mockResolvedValueOnce(
      textResponse(DECLARATION, { contentType: 'text/html; x=text/plain' }),
    );
    expect(await lookupAiSafetyDeclaration('https://example.com/')).toEqual({ status: 'none' });
  });
});

describe('the response size is capped', () => {
  /**
   * An oversize body that is nonetheless a PERFECTLY VALID declaration: the real
   * fields, then comment padding past the cap.
   *
   * This shape is what gives these tests teeth. An earlier version padded with
   * zero bytes, which parse to nothing — so the lookup returned `none` whether
   * the cap fired or not, and the test passed with the cap disabled. Padding
   * with valid content means `none` can ONLY come from the cap: remove the cap
   * and the declaration parses to `ok`, failing the test.
   */
  function oversizeValidDeclaration(): Uint8Array[] {
    const padding = `# ${'p'.repeat(1023)}\n`; // 1 KB per line
    return [
      new TextEncoder().encode(DECLARATION),
      ...Array.from({ length: 65 }, () => new TextEncoder().encode(padding)),
    ];
  }

  it('short-circuits on an oversize content-length before reading a body', async () => {
    mockFetch.mockResolvedValueOnce(
      textResponse(DECLARATION, { contentLength: String(64 * 1024 + 1) }),
    );
    // The body here is small and valid, so `none` can only come from the
    // content-length check refusing to read it at all.
    expect(await lookupAiSafetyDeclaration('https://example.com/')).toEqual({ status: 'none' });
  });

  it('caps a stream that lies about its content-length', async () => {
    // content-length is a hostile-controlled hint: an origin can declare 10
    // bytes and stream megabytes. Trusting it and buffering anyway is the DoS.
    mockFetch.mockResolvedValueOnce(streamResponse(oversizeValidDeclaration(), '10'));
    expect(await lookupAiSafetyDeclaration('https://example.com/')).toEqual({ status: 'none' });
  });

  it('caps a chunked stream with no content-length', async () => {
    mockFetch.mockResolvedValueOnce(streamResponse(oversizeValidDeclaration()));
    expect(await lookupAiSafetyDeclaration('https://example.com/')).toEqual({ status: 'none' });
  });

  it('cancels the stream instead of draining it once over the cap', async () => {
    const cancel = vi.fn().mockResolvedValue(undefined);
    let pulled = 0;
    const chunk = new TextEncoder().encode(`# ${'p'.repeat(1023)}\n`);
    mockFetch.mockResolvedValueOnce({
      type: 'basic',
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'text/plain' }),
      body: {
        getReader: () => ({
          read: async () => {
            pulled++;
            return { done: false, value: chunk };
          },
          cancel,
          releaseLock: () => {},
        }),
      },
      text: () => Promise.reject(new Error('unused')),
    });

    expect(await lookupAiSafetyDeclaration('https://example.com/')).toEqual({ status: 'none' });
    // An endless stream must not hang the lookup: the reader is cancelled the
    // moment the cap is crossed, rather than read to a `done` that never comes.
    expect(cancel).toHaveBeenCalled();
    expect(pulled).toBeLessThan(80);
  });

  it('reads a streamed declaration that is within the cap', async () => {
    mockFetch.mockResolvedValueOnce(streamResponse([new TextEncoder().encode(DECLARATION)]));
    const result = await lookupAiSafetyDeclaration('https://example.com/');
    expect(result.status).toBe('ok');
  });

  it('honours a lowered cap', async () => {
    mockFetch.mockResolvedValueOnce(textResponse(DECLARATION));
    expect(await lookupAiSafetyDeclaration('https://example.com/', { maxBytes: 4 })).toEqual({
      status: 'none',
    });
  });
});

describe('parse outcomes', () => {
  it('reports none for a file with no recognized fields', async () => {
    mockFetch.mockResolvedValueOnce(textResponse('# only comments\n\n'));
    expect(await lookupAiSafetyDeclaration('https://example.com/')).toEqual({ status: 'none' });
  });

  it('reports none for an empty body', async () => {
    mockFetch.mockResolvedValueOnce(textResponse(''));
    expect(await lookupAiSafetyDeclaration('https://example.com/')).toEqual({ status: 'none' });
  });

  it('keeps the good fields of a partly-malformed file', async () => {
    mockFetch.mockResolvedValueOnce(textResponse('AI-Safe: true\nLast-Verified: yesterday\n'));
    expect(await lookupAiSafetyDeclaration('https://example.com/')).toEqual({
      status: 'ok',
      declaration: { aiSafe: true },
    });
  });
});

describe('caching', () => {
  it('serves a repeat lookup from cache without a second request', async () => {
    mockFetch.mockResolvedValueOnce(textResponse(DECLARATION));
    const first = await lookupAiSafetyDeclaration('https://example.com/page-one');
    const second = await lookupAiSafetyDeclaration('https://example.com/page-two');

    expect(second).toEqual(first);
    // Every avoided request is one less fingerprintable signal to the origin,
    // which is why the cache is a privacy control here and not just a speedup.
    expect(mockFetch).toHaveBeenCalledOnce();
  });

  it('caches a 404 so the common no-declaration case generates no repeat traffic', async () => {
    mockFetch.mockResolvedValueOnce(textResponse('', { status: 404 }));
    await lookupAiSafetyDeclaration('https://example.com/');
    await lookupAiSafetyDeclaration('https://example.com/');
    expect(mockFetch).toHaveBeenCalledOnce();
  });

  it('caches unreachable briefly to absorb a burst', async () => {
    mockFetch.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    await lookupAiSafetyDeclaration('https://example.com/');
    await lookupAiSafetyDeclaration('https://example.com/');
    expect(mockFetch).toHaveBeenCalledOnce();
  });

  it('retries unreachable sooner than it would refresh a declaration', async () => {
    vi.useFakeTimers();
    try {
      mockFetch.mockRejectedValueOnce(new TypeError('Failed to fetch'));
      await lookupAiSafetyDeclaration('https://example.com/');

      // Past the 5 minute negative TTL, well inside the 24 hour positive one.
      vi.advanceTimersByTime(5 * 60 * 1000 + 1);

      mockFetch.mockResolvedValueOnce(textResponse(DECLARATION));
      const result = await lookupAiSafetyDeclaration('https://example.com/');
      expect(result.status).toBe('ok');
      expect(mockFetch).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not reuse one origin cache entry for another origin', async () => {
    mockFetch.mockResolvedValueOnce(textResponse(DECLARATION));
    await lookupAiSafetyDeclaration('https://a.example/');
    mockFetch.mockResolvedValueOnce(textResponse('', { status: 404 }));
    expect(await lookupAiSafetyDeclaration('https://b.example/')).toEqual({ status: 'none' });
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('does not cache the skipped non-HTTPS path', async () => {
    // No network was touched, so there is nothing to cache and no reason to
    // occupy a slot in a capped cache.
    await lookupAiSafetyDeclaration('http://example.com/');
    const stored = await chrome.storage.local.get('aiSafetyDeclarationCache');
    expect(stored.aiSafetyDeclarationCache).toBeUndefined();
  });
});

describe('a hostile declaration cannot become a favourable claim', () => {
  it('does not let an over-claiming file assert anything beyond its own fields', async () => {
    // Draft section 5.1: a declaration is self-asserted and MUST NOT be treated
    // as proof. The client's job is to report exactly what was said, no more.
    mockFetch.mockResolvedValueOnce(
      textResponse('AI-Safe: true\nInjection-Protected: true\nConsistent-Rendering: true\n'),
    );
    const result = await lookupAiSafetyDeclaration('https://evil.example/');
    expect(result).toEqual({
      status: 'ok',
      declaration: { aiSafe: true, injectionProtected: true, consistentRendering: true },
    });
    // No trust score, no verdict, no enforcement input. Display-only (ADR-009 §4).
    expect(result).not.toHaveProperty('trustScore');
  });

  it('drops a javascript: contact URI rather than surfacing it', async () => {
    mockFetch.mockResolvedValueOnce(
      textResponse('AI-Safe: true\nContact: javascript:alert(document.cookie)\n'),
    );
    const result = await lookupAiSafetyDeclaration('https://evil.example/');
    expect(result).toEqual({ status: 'ok', declaration: { aiSafe: true } });
  });
});
