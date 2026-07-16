/**
 * Persistent, bounded cache for ai-safety.txt lookups.
 *
 * Keyed by page origin, backed by `chrome.storage.local`.
 *
 * Why not an in-memory Map, as `aim/client.ts` and `registry/client.ts` use:
 *
 * 1. **The MV3 service worker unloads after ~30s idle.** A Map would be dropped
 *    on every unload, so a user browsing with an agent would re-fetch the same
 *    origin's declaration repeatedly. That is a cache that misses precisely when
 *    it matters, and each miss is another request to a third-party origin — the
 *    exact disclosure ADR-009 is trying to minimize. Here the cache is a privacy
 *    control, not just a latency optimization.
 * 2. **The key space is attacker-influenced.** The existing Maps are keyed by
 *    agent type (a closed set of ~8 strings) and have no eviction because they
 *    do not need one. This cache is keyed by origin, so its key space is
 *    unbounded. It needs an explicit cap and eviction.
 */

import type { AiSafetyLookupResult } from './types';

const CACHE_KEY = 'aiSafetyDeclarationCache';

/**
 * Maximum number of origins retained. Generous relative to real use (an origin
 * only enters the cache when an agent was detected on it) while bounding
 * worst-case storage at roughly a few hundred KB.
 */
export const MAX_CACHE_ENTRIES = 50;

interface CacheEntry {
  result: AiSafetyLookupResult;
  expiresAt: number;
  /**
   * When this entry was written. Eviction order, kept separate from `expiresAt`
   * because the two disagree: entries have different TTLs, so "expires soonest"
   * is not "written longest ago".
   */
  writtenAt: number;
}

type CacheShape = Record<string, CacheEntry>;

/**
 * Serialize read-modify-write cycles within this realm.
 *
 * `chrome.storage.local` has no atomic read-modify-write primitive (see the note
 * at `src/session/storage.ts:34`). Two agent detections landing at once would
 * otherwise both read the same base object and the second write would clobber
 * the first, losing a cached entry and causing a redundant refetch.
 */
let writeChain: Promise<unknown> = Promise.resolve();

function withCacheLock<T>(operation: () => Promise<T>): Promise<T> {
  const run = writeChain.then(operation, operation);
  // Keep the chain alive whether the operation resolves or rejects, and never
  // let a prior rejection propagate into the next queued operation.
  writeChain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/**
 * Validate an entry read back from storage.
 *
 * Storage is not attacker-writable, but it IS long-lived across extension
 * versions: an entry written by an older build, or a partially-written object,
 * would otherwise be handed to the popup as a declaration. Anything that does
 * not match the current shape is dropped rather than trusted.
 */
function isValidEntry(value: unknown): value is CacheEntry {
  if (typeof value !== 'object' || value === null) return false;
  const entry = value as Record<string, unknown>;
  if (typeof entry.expiresAt !== 'number' || !Number.isFinite(entry.expiresAt)) return false;
  if (typeof entry.writtenAt !== 'number' || !Number.isFinite(entry.writtenAt)) return false;

  const result = entry.result;
  if (typeof result !== 'object' || result === null) return false;
  const status = (result as Record<string, unknown>).status;
  if (status === 'none' || status === 'unreachable') return true;
  if (status !== 'ok') return false;

  const declaration = (result as Record<string, unknown>).declaration;
  return typeof declaration === 'object' && declaration !== null;
}

async function readCache(): Promise<CacheShape> {
  let raw: unknown;
  try {
    const stored = await chrome.storage.local.get(CACHE_KEY);
    raw = stored[CACHE_KEY];
  } catch {
    return {};
  }
  if (typeof raw !== 'object' || raw === null) return {};

  const clean: CacheShape = {};
  for (const [origin, entry] of Object.entries(raw as Record<string, unknown>)) {
    // `clean['__proto__'] = entry` would set the prototype rather than a key.
    // Unreachable today — keys are `new URL().origin` values, which always look
    // like "https://host" — but this loop reads whatever is on disk, and the
    // cost of not having to re-derive that safety argument later is one line.
    if (origin === '__proto__' || origin === 'constructor' || origin === 'prototype') continue;
    if (isValidEntry(entry)) clean[origin] = entry;
  }
  return clean;
}

/**
 * Drop expired entries, then evict the longest-written entries until the cache
 * is at cap.
 *
 * Eviction is ordered by `writtenAt` (FIFO), NOT by `expiresAt`. Ordering by
 * expiry looks equivalent and is not, because the TTLs differ by outcome:
 *
 *   An `unreachable` entry is written with a 5 minute TTL, so its `expiresAt`
 *   is SOONER than that of all 50 existing 24-hour entries. Expiry-ordered
 *   eviction therefore sorts the entry we just wrote to the front and discards
 *   it immediately — every time the cache is full. The negative cache silently
 *   becomes a no-op, and a broken origin gets re-fetched on every single agent
 *   detection: the repeat traffic the TTL exists to prevent, and, since every
 *   request is a fingerprintable signal to a third party, a privacy regression
 *   rather than a latency one.
 *
 * FIFO cannot do that: the entry just written always has the newest `writtenAt`.
 *
 * True LRU is deliberately not implemented: it would require a storage write on
 * every cache *read*, turning the common hit path into a write and defeating the
 * point of the cache.
 */
function evict(cache: CacheShape, now: number): CacheShape {
  const live = Object.entries(cache).filter(([, entry]) => entry.expiresAt > now);
  if (live.length <= MAX_CACHE_ENTRIES) return Object.fromEntries(live);

  live.sort((a, b) => a[1].writtenAt - b[1].writtenAt);
  return Object.fromEntries(live.slice(live.length - MAX_CACHE_ENTRIES));
}

/**
 * Read a cached lookup for an origin.
 *
 * Returns null on a miss or an expired entry, which the caller treats as "go ask
 * the network" (subject to the feature gate).
 */
export async function readCachedLookup(origin: string): Promise<AiSafetyLookupResult | null> {
  const cache = await readCache();
  const entry = cache[origin];
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) return null;
  return entry.result;
}

/**
 * Store a lookup result for an origin, evicting to stay at cap.
 *
 * Never throws: a storage failure degrades to "not cached", which costs a
 * refetch but is never a correctness problem.
 */
export async function writeCachedLookup(
  origin: string,
  result: AiSafetyLookupResult,
  ttlMs: number,
): Promise<void> {
  await withCacheLock(async () => {
    try {
      const now = Date.now();
      const cache = await readCache();
      cache[origin] = { result, expiresAt: now + ttlMs, writtenAt: now };
      await chrome.storage.local.set({ [CACHE_KEY]: evict(cache, now) });
    } catch {
      /* Cache writes are best-effort. */
    }
  });
}

/**
 * Remove every cached entry. Used on opt-out and by tests.
 *
 * Deliberately NOT best-effort, unlike `writeCachedLookup`. A failed write costs
 * a refetch; a failed clear leaves third-party data on disk after the user
 * revoked consent, and the privacy policy states that turning the setting off
 * deletes every stored declaration. So this rejects, and the caller reports the
 * failure rather than answering "success" for a promise it did not keep.
 */
export async function clearAiSafetyCache(): Promise<void> {
  await withCacheLock(async () => {
    await chrome.storage.local.remove(CACHE_KEY);
  });
}

/** Number of live (unexpired) cached entries. Test/diagnostic helper. */
export async function getAiSafetyCacheSize(): Promise<number> {
  const cache = await readCache();
  const now = Date.now();
  return Object.values(cache).filter((entry) => entry.expiresAt > now).length;
}
