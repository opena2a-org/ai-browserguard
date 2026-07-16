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

  it('evicts the entries closest to expiry first, keeping the newest', async () => {
    vi.useFakeTimers();
    // Same TTL, so expiry order is insertion order.
    for (let i = 0; i < MAX_CACHE_ENTRIES; i++) {
      await writeCachedLookup(`https://origin-${i}.example`, OK, TTL);
      vi.advanceTimersByTime(10);
    }
    await writeCachedLookup('https://newest.example', OK, TTL);

    expect(await readCachedLookup('https://origin-0.example')).toBeNull();
    expect(await readCachedLookup('https://newest.example')).toEqual(OK);
    expect(await getAiSafetyCacheSize()).toBe(MAX_CACHE_ENTRIES);
  });

  it('evicts a short-TTL unreachable entry before a real declaration', async () => {
    vi.useFakeTimers();
    // An `unreachable` entry is worth little and is cheap to re-derive, so
    // expiry-ordered eviction should shed it before a parsed declaration.
    await writeCachedLookup('https://transient.example', { status: 'unreachable' }, 1_000);
    for (let i = 0; i < MAX_CACHE_ENTRIES; i++) {
      await writeCachedLookup(`https://origin-${i}.example`, OK, TTL);
    }
    expect(await readCachedLookup('https://transient.example')).toBeNull();
    expect(await readCachedLookup('https://origin-0.example')).toEqual(OK);
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
    ['an entry with no expiry', { 'https://x.example': { result: OK } }],
    ['an entry with no result', { 'https://x.example': { expiresAt: Date.now() + TTL } }],
    ['an ok entry with no declaration', {
      'https://x.example': { result: { status: 'ok' }, expiresAt: Date.now() + TTL },
    }],
    ['an unknown status', {
      'https://x.example': { result: { status: 'trusted' }, expiresAt: Date.now() + TTL },
    }],
  ])('drops %s', async (_label, blob) => {
    await chrome.storage.local.set({ aiSafetyDeclarationCache: blob });
    expect(await readCachedLookup('https://x.example')).toBeNull();
    expect(await getAiSafetyCacheSize()).toBe(0);
  });

  it('keeps valid entries alongside dropped ones', async () => {
    await chrome.storage.local.set({
      aiSafetyDeclarationCache: {
        'https://good.example': { result: OK, expiresAt: Date.now() + TTL },
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
});
