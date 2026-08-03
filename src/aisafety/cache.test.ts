import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  readCachedLookup,
  writeCachedLookup,
  writeCachedLookupUnlessCleared,
  getClearGeneration,
  clearAiSafetyCache,
  getAiSafetyCacheSize,
  getStoredEntryCount,
  getUnreachableFailureCount,
  MAX_CACHE_ENTRIES,
  CACHE_FORMAT_VERSION,
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
    expect(Object.keys(stored.aiSafetyDeclarationCache.entries)).toEqual(['https://new.example']);
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
          v: CACHE_FORMAT_VERSION,
          entries: {
            [key]: { result: OK, expiresAt: Date.now() + TTL, seq: 1 },
            'https://real.example': { result: OK, expiresAt: Date.now() + TTL, seq: 2 },
          },
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
        v: CACHE_FORMAT_VERSION,
        entries: {
          'https://good.example': { result: OK, expiresAt: Date.now() + TTL, seq: 1 },
          'https://bad.example': { result: { status: 'ok' } },
        },
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

describe('getStoredEntryCount counts bytes on disk, whatever their shape', () => {
  it('reports a non-object value at the key as data to delete, not as absent', async () => {
    // The delete obligation is about BYTES ON DISK. A bare string or number at
    // the cache key is not `undefined`, so it is data the opt-out promise must
    // cover. The old guard (`typeof raw !== 'object' -> 0`) reused the READER's
    // "serve nothing" shape as the DELETER's "nothing to delete" -- the same
    // inversion that hid the live-vs-stored bug -- and reported the data as
    // already gone. Deciding on that count means a failed opt-out delete would
    // "settle" while a string sat on disk.
    await chrome.storage.local.set({ aiSafetyDeclarationCache: 'unexpected string' });
    expect(await getStoredEntryCount()).toBe(1);
  });

  it('reports 0 only when the key is genuinely absent', async () => {
    await clearAiSafetyCache();
    expect(await getStoredEntryCount()).toBe(0);
  });
});

describe('writeCachedLookupUnlessCleared voids a write that a clear raced', () => {
  it('writes when no clear ran since the generation was captured', async () => {
    const gen = getClearGeneration();
    expect(await writeCachedLookupUnlessCleared('https://a.example', OK, TTL, gen)).toBe('written');
    expect(await readCachedLookup('https://a.example')).toEqual(OK);
  });

  it('refuses the write when a clear ran after the generation was captured', async () => {
    // The TOCTOU, deterministically. A lookup captures the generation before its
    // fetch; the user opts out mid-fetch, so clearAiSafetyCache runs and bumps
    // the generation; the straggler then tries to store its result. Without the
    // guard the entry lands on disk moments after consent was revoked. With it,
    // the stale generation makes the write a no-op.
    const gen = getClearGeneration();
    await clearAiSafetyCache(); // the opt-out's delete, racing the in-flight lookup

    expect(await writeCachedLookupUnlessCleared('https://a.example', OK, TTL, gen)).toBe('revoked');
    const stored = await chrome.storage.local.get('aiSafetyDeclarationCache');
    expect(stored.aiSafetyDeclarationCache).toBeUndefined();
  });

  it('reports error (not revoked) when the write fails with consent intact', async () => {
    // A storage hiccup with no clear racing must stay distinguishable from a
    // revoke: the fetched declaration is still legitimate to display, just not
    // cached. Collapsing the two would suppress valid declarations on any
    // transient write failure.
    const gen = getClearGeneration();
    const set = chrome.storage.local.set as unknown as ReturnType<typeof vi.fn>;
    const original = set.getMockImplementation();
    set.mockRejectedValueOnce(new Error('storage unavailable'));
    try {
      expect(await writeCachedLookupUnlessCleared('https://a.example', OK, TTL, gen)).toBe('error');
    } finally {
      if (original) set.mockImplementation(original);
    }
  });
});

describe('cache format versioning', () => {
  it('drops a pre-versioning (0.6.x) flat record instead of serving it', async () => {
    // The 0.6.x format was a bare Record<origin, entry> under the same key.
    // Its entries pass the per-entry shape check, so without the version gate
    // they would be SERVED by a build whose format has moved on.
    await chrome.storage.local.set({
      aiSafetyDeclarationCache: {
        'https://legacy.example': { result: OK, expiresAt: Date.now() + TTL, seq: 1 },
      },
    });
    expect(await readCachedLookup('https://legacy.example')).toBeNull();
    expect(await getAiSafetyCacheSize()).toBe(0);
  });

  it('drops a FUTURE format version instead of half-parsing it', async () => {
    await chrome.storage.local.set({
      aiSafetyDeclarationCache: {
        v: CACHE_FORMAT_VERSION + 1,
        entries: {
          'https://future.example': { result: OK, expiresAt: Date.now() + TTL, seq: 1 },
        },
      },
    });
    expect(await readCachedLookup('https://future.example')).toBeNull();
  });

  it('still counts legacy bytes for the opt-out deleter', async () => {
    // The reader must not serve a legacy record, but the opt-out promise is
    // about bytes on disk — the deleter must still see them as outstanding.
    await chrome.storage.local.set({
      aiSafetyDeclarationCache: {
        'https://legacy-a.example': { result: OK, expiresAt: Date.now() + TTL, seq: 1 },
        'https://legacy-b.example': { result: OK, expiresAt: 0, seq: 2 },
      },
    });
    expect(await getStoredEntryCount()).toBe(2);
    await clearAiSafetyCache();
    expect(await getStoredEntryCount()).toBe(0);
  });

  it('writes the current version wrapper', async () => {
    await writeCachedLookup('https://example.com', OK, TTL);
    const stored = await chrome.storage.local.get('aiSafetyDeclarationCache');
    expect(stored.aiSafetyDeclarationCache.v).toBe(CACHE_FORMAT_VERSION);
    expect(Object.keys(stored.aiSafetyDeclarationCache.entries)).toEqual(['https://example.com']);
  });
});

describe('unreachable failure count', () => {
  const UNREACHABLE: AiSafetyLookupResult = { status: 'unreachable' };

  it('is 0 for a missing origin', async () => {
    expect(await getUnreachableFailureCount('https://example.com')).toBe(0);
  });

  it('is 0 when the last settle was ok/none', async () => {
    await writeCachedLookup('https://example.com', OK, TTL);
    expect(await getUnreachableFailureCount('https://example.com')).toBe(0);
  });

  it('reads the recorded count back', async () => {
    await writeCachedLookup('https://example.com', UNREACHABLE, TTL, { failures: 3 });
    expect(await getUnreachableFailureCount('https://example.com')).toBe(3);
  });

  it('reads the count from an EXPIRED entry — that is the retry moment it exists for', async () => {
    vi.useFakeTimers();
    await writeCachedLookup('https://example.com', UNREACHABLE, 1000, { failures: 2 });
    vi.advanceTimersByTime(5000);
    expect(await readCachedLookup('https://example.com')).toBeNull();
    expect(await getUnreachableFailureCount('https://example.com')).toBe(2);
  });

  it('treats a counter-less unreachable entry as one failure (pre-backoff write)', async () => {
    await writeCachedLookup('https://example.com', UNREACHABLE, TTL);
    expect(await getUnreachableFailureCount('https://example.com')).toBe(1);
  });

  it('an ok settle resets the count', async () => {
    await writeCachedLookup('https://example.com', UNREACHABLE, TTL, { failures: 4 });
    await writeCachedLookup('https://example.com', OK, TTL);
    expect(await getUnreachableFailureCount('https://example.com')).toBe(0);
  });
});

describe('concurrent clear/write chaos', () => {
  // chrome.storage.local has no atomic read-modify-write and the opt-out's
  // clear races in-flight lookups. Enumerate every enqueue order of
  // {guarded write, clear, guarded write} — the lock serializes execution in
  // enqueue order, so these ARE the reachable interleavings — and assert the
  // one invariant that must survive all of them: a write whose generation was
  // captured before the LAST clear never leaves bytes on disk.
  it('a stale-generation write never lands, in any enqueue order', async () => {
    const OKB: AiSafetyLookupResult = { status: 'ok', declaration: { aiSafe: false } };
    const orders: Array<Array<'w1' | 'w2' | 'clear'>> = [
      ['w1', 'clear', 'w2'],
      ['w1', 'w2', 'clear'],
      ['clear', 'w1', 'w2'],
    ];
    for (const order of orders) {
      await clearAiSafetyCache();
      const gen = getClearGeneration(); // both writes capture a pre-clear generation
      const ops = {
        w1: () => writeCachedLookupUnlessCleared('https://w1.example', OK, TTL, gen),
        w2: () => writeCachedLookupUnlessCleared('https://w2.example', OKB, TTL, gen),
        clear: () => clearAiSafetyCache(),
      };
      const settled = await Promise.all(order.map((k) => ops[k]()));
      const outcomes = Object.fromEntries(order.map((k, i) => [k, settled[i]]));

      const clearIdx = order.indexOf('clear');
      for (const key of ['w1', 'w2'] as const) {
        const expectWritten = order.indexOf(key) < clearIdx;
        expect(outcomes[key], `${key} in order [${order.join(',')}]`)
          .toBe(expectWritten ? 'written' : 'revoked');
      }
      // Regardless of order: after the clear has been part of the schedule,
      // anything written BEFORE it was deleted and anything after was revoked,
      // so nothing survives on disk.
      const clearedBeforeSomeWrite = clearIdx < order.length - 1;
      const size = await getAiSafetyCacheSize();
      const stored = await getStoredEntryCount();
      if (clearedBeforeSomeWrite) {
        // Writes enqueued after the clear were revoked; only pre-clear writes
        // could have landed and the clear wiped them.
        expect(size, `order [${order.join(',')}]`).toBe(0);
        expect(stored, `order [${order.join(',')}]`).toBe(0);
      } else {
        // clear last: everything written first, then wiped.
        expect(size).toBe(0);
        expect(stored).toBe(0);
      }
    }
  });

  it('interleaved unconditional writes and clears keep the chain live and end clean', async () => {
    // 20 writes racing 4 clears through the same lock: whatever the ordering,
    // the module must not deadlock, must not reject, and a final clear must
    // leave zero bytes.
    const burst = [];
    for (let i = 0; i < 20; i++) {
      burst.push(writeCachedLookup(`https://origin-${i}.example`, OK, TTL));
      if (i % 5 === 4) burst.push(clearAiSafetyCache());
    }
    await Promise.all(burst);
    await clearAiSafetyCache();
    expect(await getStoredEntryCount()).toBe(0);
    // The chain still works after the storm.
    await writeCachedLookup('https://after.example', OK, TTL);
    expect(await readCachedLookup('https://after.example')).toEqual(OK);
  });
});
