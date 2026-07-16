import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  readCachedLookup,
  writeCachedLookup,
  clearAiSafetyCache,
  getAiSafetyCacheSize,
  MAX_CACHE_ENTRIES,
} from './cache';
import type { AiSafetyLookupResult } from './types';

const OK: AiSafetyLookupResult = { status: 'ok', declaration: { aiSafe: true } };
const TTL = 60_000;

beforeEach(async () => {
  await clearAiSafetyCache();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('read/write round trip', () => {
  it('returns null on a miss', async () => {
    expect(await readCachedLookup('https://example.com')).toBeNull();
  });

  it('returns a written entry', async () => {
    await writeCachedLookup('https://example.com', OK, TTL);
    expect(await readCachedLookup('https://example.com')).toEqual(OK);
  });

  it('keys entries by origin', async () => {
    await writeCachedLookup('https://a.example', OK, TTL);
    await writeCachedLookup('https://b.example', { status: 'none' }, TTL);
    expect(await readCachedLookup('https://a.example')).toEqual(OK);
    expect(await readCachedLookup('https://b.example')).toEqual({ status: 'none' });
  });

  it('survives a simulated service worker unload', async () => {
    // The reason this cache is storage-backed rather than an in-memory Map: the
    // MV3 worker unloads after ~30s idle. Storage is the only layer that
    // survives, and every miss here is another request to a third-party origin.
    await writeCachedLookup('https://example.com', OK, TTL);
    vi.resetModules();
    const fresh = await import('./cache');
    expect(await fresh.readCachedLookup('https://example.com')).toEqual(OK);
  });
});

describe('expiry', () => {
  it('returns null once an entry has expired', async () => {
    vi.useFakeTimers();
    await writeCachedLookup('https://example.com', OK, TTL);
    expect(await readCachedLookup('https://example.com')).toEqual(OK);

    vi.advanceTimersByTime(TTL + 1);
    expect(await readCachedLookup('https://example.com')).toBeNull();
  });

  it('does not count expired entries toward size', async () => {
    vi.useFakeTimers();
    await writeCachedLookup('https://example.com', OK, TTL);
    vi.advanceTimersByTime(TTL + 1);
    expect(await getAiSafetyCacheSize()).toBe(0);
  });
});

describe('cap and eviction', () => {
  it('never exceeds the cap', async () => {
    for (let i = 0; i < MAX_CACHE_ENTRIES + 20; i++) {
      await writeCachedLookup(`https://origin-${i}.example`, OK, TTL);
    }
    expect(await getAiSafetyCacheSize()).toBe(MAX_CACHE_ENTRIES);
  });

  it('evicts the longest-written entry first, keeping the newest', async () => {
    vi.useFakeTimers();
    for (let i = 0; i < MAX_CACHE_ENTRIES; i++) {
      await writeCachedLookup(`https://origin-${i}.example`, OK, TTL);
      vi.advanceTimersByTime(10);
    }
    await writeCachedLookup('https://newest.example', OK, TTL);

    expect(await readCachedLookup('https://origin-0.example')).toBeNull();
    expect(await readCachedLookup('https://newest.example')).toEqual(OK);
    expect(await getAiSafetyCacheSize()).toBe(MAX_CACHE_ENTRIES);
  });

  it('keeps a short-TTL entry written into a FULL cache of long-TTL entries', async () => {
    vi.useFakeTimers();
    // The regression. `unreachable` is written with a 5 min TTL while real
    // declarations get 24 h, so the new entry's expiresAt is SOONER than all 50
    // existing ones. Expiry-ordered eviction sorted the just-written entry to
    // the front and dropped it immediately, making the negative cache a no-op
    // and re-fetching a broken origin on every single detection.
    //
    // Order matters: fill the cache FIRST, then write. Writing the short-TTL
    // entry first and filling afterwards passes against the buggy code.
    for (let i = 0; i < MAX_CACHE_ENTRIES; i++) {
      await writeCachedLookup(`https://origin-${i}.example`, OK, TTL);
      vi.advanceTimersByTime(10);
    }
    await writeCachedLookup('https://transient.example', { status: 'unreachable' }, 1_000);

    expect(await readCachedLookup('https://transient.example')).toEqual({ status: 'unreachable' });
    // It displaced the oldest-written entry, not itself.
    expect(await readCachedLookup('https://origin-0.example')).toBeNull();
    expect(await getAiSafetyCacheSize()).toBe(MAX_CACHE_ENTRIES);
  });

  it('evicts by write order, not by expiry order', async () => {
    vi.useFakeTimers();
    // A long-TTL entry written long ago must go before a short-TTL entry written
    // recently, even though the long-TTL one expires much later.
    await writeCachedLookup('https://oldest.example', OK, TTL);
    vi.advanceTimersByTime(1_000);
    for (let i = 0; i < MAX_CACHE_ENTRIES - 1; i++) {
      await writeCachedLookup(`https://origin-${i}.example`, OK, TTL);
      vi.advanceTimersByTime(10);
    }
    // TTL must be genuinely shorter than the others, or expiry order and write
    // order coincide and this proves nothing.
    await writeCachedLookup('https://newest-but-short.example', { status: 'unreachable' }, 1_000);

    expect(await readCachedLookup('https://oldest.example')).toBeNull();
    expect(await readCachedLookup('https://newest-but-short.example')).toEqual({
      status: 'unreachable',
    });
  });

  it('keeps a new entry when the wall clock jumps BACKWARDS', async () => {
    vi.useFakeTimers();
    // Ordering by a timestamp is only FIFO while the clock moves forward.
    // Date.now() is wall-clock: an NTP correction, a VM resume, or a user clock
    // change moves it backwards, and a timestamp-ordered cache then sorts the
    // freshly written entry to the front and evicts it — the original
    // negative-cache no-op, returning behind a clock event instead of a TTL
    // difference. Deriving the ordinal from the stored entries removes the
    // clock from the invariant entirely.
    for (let i = 0; i < MAX_CACHE_ENTRIES; i++) {
      await writeCachedLookup(`https://origin-${i}.example`, OK, TTL);
      vi.advanceTimersByTime(10);
    }
    vi.setSystemTime(new Date(Date.now() - 60 * 60 * 1000)); // clock jumps back an hour

    await writeCachedLookup('https://after-jump.example', { status: 'unreachable' }, 5 * 60_000);
    expect(await readCachedLookup('https://after-jump.example')).toEqual({ status: 'unreachable' });
  });

  it('keeps a new entry across a service-worker restart', async () => {
    vi.useFakeTimers();
    // A module-level counter would reset to 0 on every ~30s idle unload, so
    // every post-restart entry would sort before every existing one and evict
    // itself. The ordinal is read back from storage, so it survives.
    for (let i = 0; i < MAX_CACHE_ENTRIES; i++) {
      await writeCachedLookup(`https://origin-${i}.example`, OK, TTL);
    }
    vi.resetModules();
    const fresh = await import('./cache');

    await fresh.writeCachedLookup('https://after-restart.example', OK, TTL);
    expect(await fresh.readCachedLookup('https://after-restart.example')).toEqual(OK);
    expect(await fresh.getAiSafetyCacheSize()).toBe(MAX_CACHE_ENTRIES);
  });

  it('purges expired entries on write', async () => {
    vi.useFakeTimers();
    await writeCachedLookup('https://old.example', OK, TTL);
    vi.advanceTimersByTime(TTL + 1);
    await writeCachedLookup('https://new.example', OK, TTL);
    // The expired entry is dropped from storage, not merely hidden on read.
    const stored = await chrome.storage.local.get('aiSafetyDeclarationCache');
    expect(Object.keys(stored.aiSafetyDeclarationCache)).toEqual(['https://new.example']);
  });
});

describe('concurrent writes', () => {
  it('does not lose entries when writes interleave', async () => {
    // chrome.storage.local has no atomic read-modify-write. Without the mutex,
    // these read the same base object and the last write wins, silently losing
    // the others.
    await Promise.all([
      writeCachedLookup('https://a.example', OK, TTL),
      writeCachedLookup('https://b.example', OK, TTL),
      writeCachedLookup('https://c.example', OK, TTL),
    ]);
    expect(await getAiSafetyCacheSize()).toBe(3);
  });
});

describe('corrupt storage is not trusted', () => {
  it.each([
    ['not an object', 'garbage'],
    ['an entry with no expiry', { 'https://x.example': { result: OK, seq: 1 } }],
    ['an entry with no seq', { 'https://x.example': { result: OK, expiresAt: Date.now() + TTL } }],
    ['an entry with no result', { 'https://x.example': { expiresAt: Date.now() + TTL, seq: 1 } }],
    ['an ok entry with no declaration', {
      'https://x.example': { result: { status: 'ok' }, expiresAt: Date.now() + TTL, seq: 1 },
    }],
    ['an unknown status', {
      'https://x.example': { result: { status: 'trusted' }, expiresAt: Date.now() + TTL, seq: 1 },
    }],
  ])('drops %s', async (_label, blob) => {
    await chrome.storage.local.set({ aiSafetyDeclarationCache: blob });
    expect(await readCachedLookup('https://x.example')).toBeNull();
    expect(await getAiSafetyCacheSize()).toBe(0);
  });

  it.each(['__proto__', 'constructor', 'prototype'])(
    'does not let the key %j reach an object assignment',
    async (key) => {
      // `clean['__proto__'] = entry` invokes the prototype setter rather than
      // adding a key. Not reachable today (keys are always new URL().origin, so
      // "https://..."), but this loop reads whatever is on disk.
      await chrome.storage.local.set({
        aiSafetyDeclarationCache: {
          [key]: { result: OK, expiresAt: Date.now() + TTL, seq: 1 },
          'https://real.example': { result: OK, expiresAt: Date.now() + TTL, seq: 2 },
        },
      });

      expect(await readCachedLookup(key)).toBeNull();
      // The real entry alongside it still reads back, and the cache did not
      // acquire a polluted prototype.
      expect(await readCachedLookup('https://real.example')).toEqual(OK);
      expect(await getAiSafetyCacheSize()).toBe(1);
      expect(({} as Record<string, unknown>).result).toBeUndefined();
    },
  );

  it('keeps valid entries alongside dropped ones', async () => {
    await chrome.storage.local.set({
      aiSafetyDeclarationCache: {
        'https://good.example': { result: OK, expiresAt: Date.now() + TTL, seq: 1 },
        'https://bad.example': { result: { status: 'ok' } },
      },
    });
    expect(await readCachedLookup('https://good.example')).toEqual(OK);
    expect(await readCachedLookup('https://bad.example')).toBeNull();
  });
});

describe('clearAiSafetyCache', () => {
  it('removes every entry', async () => {
    await writeCachedLookup('https://a.example', OK, TTL);
    await writeCachedLookup('https://b.example', OK, TTL);
    await clearAiSafetyCache();
    expect(await getAiSafetyCacheSize()).toBe(0);
  });

  it('rejects when the delete fails, rather than reporting a false success', async () => {
    // Not best-effort, unlike a write. A failed write costs a refetch; a failed
    // clear leaves third-party data on disk after the user revoked consent,
    // while the privacy policy says opting out deletes every stored
    // declaration. The caller must be able to tell that apart from success.
    const remove = chrome.storage.local.remove as unknown as ReturnType<typeof vi.fn>;
    const original = remove.getMockImplementation();
    remove.mockRejectedValueOnce(new Error('storage unavailable'));
    try {
      await expect(clearAiSafetyCache()).rejects.toThrow('storage unavailable');
    } finally {
      if (original) remove.mockImplementation(original);
    }
  });
});
