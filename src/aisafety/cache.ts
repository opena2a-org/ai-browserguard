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
   * Write ordinal. Eviction order, kept separate from `expiresAt` because the
   * two disagree: entries have different TTLs, so "expires soonest" is not
   * "written longest ago".
   *
   * A counter rather than a timestamp, and derived from the cache's own contents
   * (`1 + max(existing)`) rather than from a clock or a module variable:
   *
   *   - `Date.now()` is wall-clock, not monotonic. An NTP correction, a VM
   *     resume, or a user clock change moves it BACKWARDS, and then a freshly
   *     written entry is no longer the newest — it sorts to the front and evicts
   *     itself, which is the original negative-cache bug returning behind a
   *     clock event.
   *   - A module-level counter resets to 0 every time the MV3 worker unloads
   *     (~30s idle), so after a restart every new entry would sort before every
   *     existing one. Worse, and constantly.
   *
   * Deriving it from the stored entries makes "the entry just written has the
   * highest ordinal" structurally true: clock-independent and restart-proof.
   * Writes are serialised by `withCacheLock`, so the read-then-max-then-write is
   * not racy.
   */
  seq: number;
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
 * How many times the cache has been cleared this worker lifetime.
 *
 * A lookup captures this before its fetch and hands it to
 * `writeCachedLookupUnlessCleared`, which refuses to write if it changed. That
 * is what closes the opt-out TOCTOU: the gate is checked before a fetch that can
 * take five seconds, and if the user opts out during it, the opt-out's
 * `clearAiSafetyCache` runs and bumps this, so the straggler write is voided
 * instead of restoring a declaration on disk moments after consent was revoked.
 *
 * A module counter is correct HERE, unlike the per-entry `seq` (which is derived
 * from the cache precisely so it survives a worker restart). This one guards a
 * single in-flight lookup, and a lookup cannot outlive its worker: an MV3
 * teardown abandons the fetch promise, so `settle` never runs. Resetting to 0 on
 * restart is therefore unobservable -- there is no lookup from before the
 * restart to be fooled by it. The bump lives inside `withCacheLock`, the same
 * lock a write takes, so no clear can slip between a write's generation check and
 * its `set`.
 */
let clearGeneration = 0;

export function getClearGeneration(): number {
  return clearGeneration;
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
  if (typeof entry.seq !== 'number' || !Number.isFinite(entry.seq)) return false;

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

  // Prototype-less, so the cache has no inherited keys at all.
  //
  // A denylist of `__proto__`/`constructor`/`prototype` on the WRITE below is
  // not sufficient, which is easy to get wrong: the danger is on the READ side
  // too. With a normal `{}`, `cache['constructor']` returns Object's constructor
  // — truthy — so `readCachedLookup` sails past its `if (!entry) return null`
  // guard, reads `entry.expiresAt` as undefined, and returns `entry.result`,
  // also undefined. Its caller checks `cached !== null`, so `undefined` would be
  // handed back as if it were a lookup result. `Object.create(null)` makes every
  // such key simply absent, which is the honest answer.
  //
  // Not reachable today (keys are always `new URL().origin`, so "https://..."),
  // but this loop deserializes whatever is on disk, and being structurally
  // unable to do the wrong thing beats a list of names to remember.
  const clean: CacheShape = Object.create(null) as CacheShape;
  for (const [origin, entry] of Object.entries(raw as Record<string, unknown>)) {
    if (origin === '__proto__' || origin === 'constructor' || origin === 'prototype') continue;
    if (isValidEntry(entry)) clean[origin] = entry;
  }
  return clean;
}

/**
 * Drop expired entries, then evict the longest-written entries until the cache
 * is at cap.
 *
 * Eviction is ordered by `seq` (FIFO), NOT by `expiresAt`. Ordering by expiry
 * looks equivalent and is not, because the TTLs differ by outcome:
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
 * FIFO cannot do that: the entry just written always has the highest `seq`, by
 * construction (see `nextSeq`) rather than by trusting a clock.
 *
 * True LRU is deliberately not implemented: it would require a storage write on
 * every cache *read*, turning the common hit path into a write and defeating the
 * point of the cache.
 */
function evict(cache: CacheShape, now: number): CacheShape {
  const live = Object.entries(cache).filter(([, entry]) => entry.expiresAt > now);
  if (live.length <= MAX_CACHE_ENTRIES) return Object.fromEntries(live);

  live.sort((a, b) => a[1].seq - b[1].seq);
  return Object.fromEntries(live.slice(live.length - MAX_CACHE_ENTRIES));
}

/**
 * The next write ordinal: one past the highest currently stored.
 *
 * Derived from the cache rather than a clock or a module variable, so it cannot
 * go backwards across a clock change or a service-worker restart.
 */
function nextSeq(cache: CacheShape): number {
  let max = 0;
  for (const entry of Object.values(cache)) {
    if (entry.seq > max) max = entry.seq;
  }
  return max + 1;
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
 * Read-modify-write the cache with one new entry, evicting to stay at cap.
 * Assumes it already holds the cache lock.
 */
async function commitEntry(
  origin: string,
  result: AiSafetyLookupResult,
  ttlMs: number,
): Promise<void> {
  const now = Date.now();
  const cache = await readCache();
  cache[origin] = { result, expiresAt: now + ttlMs, seq: nextSeq(cache) };
  await chrome.storage.local.set({ [CACHE_KEY]: evict(cache, now) });
}

/**
 * Store a lookup result for an origin, evicting to stay at cap.
 *
 * Never throws: a storage failure degrades to "not cached", which costs a
 * refetch but is never a correctness problem.
 *
 * Unconditional: use `writeCachedLookupUnlessCleared` for a write that must be
 * voided if the user opted out mid-lookup. This variant is for seeding and for
 * paths where no clear can be racing.
 */
export async function writeCachedLookup(
  origin: string,
  result: AiSafetyLookupResult,
  ttlMs: number,
): Promise<void> {
  await withCacheLock(async () => {
    try {
      await commitEntry(origin, result, ttlMs);
    } catch {
      /* Cache writes are best-effort. */
    }
  });
}

/** Outcome of a consent-guarded write. */
export type GuardedWriteOutcome =
  /** Written to disk. */
  | 'written'
  /** A clear (opt-out) ran since `sinceGeneration` was captured; not written. */
  | 'revoked'
  /** A storage error; not written, but consent was intact -- caller may display. */
  | 'error';

/**
 * Store a lookup result ONLY if no clear has run since `sinceGeneration`.
 *
 * This is the disk half of the opt-out TOCTOU fix. The generation check and the
 * `set` both run inside `withCacheLock`, the same lock `clearAiSafetyCache`
 * takes to bump the generation, so the two cannot interleave:
 *
 *   - If this section runs before the opt-out's clear section, it may write --
 *     and the clear, queued after, then removes the whole key. Not left on disk.
 *   - If the clear section runs first, it bumps the generation and removes the
 *     key; this section sees the changed generation and returns `revoked`.
 *
 * Distinguishes `revoked` (consent gone -- caller must not display either) from
 * `error` (a storage hiccup with consent intact -- the fetched declaration is
 * still legitimate to show, just uncached), so a transient write failure does
 * not suppress a valid declaration.
 */
export async function writeCachedLookupUnlessCleared(
  origin: string,
  result: AiSafetyLookupResult,
  ttlMs: number,
  sinceGeneration: number,
): Promise<GuardedWriteOutcome> {
  return withCacheLock(async () => {
    if (clearGeneration !== sinceGeneration) return 'revoked';
    try {
      await commitEntry(origin, result, ttlMs);
      return 'written';
    } catch {
      return 'error';
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
    // Bump inside the lock, before the remove. Any in-flight lookup that
    // captured the old generation now reads a different one and voids its write
    // (see writeCachedLookupUnlessCleared). Bumping even if the remove below
    // rejects is deliberate: the user's intent to revoke happened, so a
    // straggler must not repopulate the cache regardless of whether this
    // particular delete landed -- the reconcile will retry the delete itself.
    clearGeneration += 1;
    await chrome.storage.local.remove(CACHE_KEY);
  });
}

/**
 * Number of live (unexpired) cached entries. Test/diagnostic helper.
 *
 * Answers "what would a reader serve?", NOT "what is on disk?" — expired entries
 * are invisible here but still stored. Do not use this to decide whether data
 * needs deleting; use `getStoredEntryCount`.
 */
export async function getAiSafetyCacheSize(): Promise<number> {
  const cache = await readCache();
  const now = Date.now();
  return Object.values(cache).filter((entry) => entry.expiresAt > now).length;
}

/**
 * Number of entries physically present in storage, expired or not, valid or not.
 *
 * This is the predicate for "is there anything to delete?", and it is emphatically
 * NOT `getAiSafetyCacheSize`. That one counts what a reader would serve, and the
 * gap between the two is permanent:
 *
 *   - `readCache` never writes back, so reading does not purge anything.
 *   - `evict` only runs inside `writeCachedLookup`, which is gated OFF while the
 *     user is opted out.
 *
 * So once a user opts out, expired entries are immortal. Deciding on the live
 * count meant a failed opt-out delete resolved itself into "nothing outstanding"
 * the moment the TTL lapsed — five minutes, for an `unreachable` entry — while
 * the origins stayed on disk, and the popup then told the user the deletion had
 * succeeded. The privacy promise is about bytes on disk, so this counts bytes on
 * disk: raw keys, before any validity or expiry filter.
 */
export async function getStoredEntryCount(): Promise<number> {
  let raw: unknown;
  try {
    const stored = await chrome.storage.local.get(CACHE_KEY);
    raw = stored[CACHE_KEY];
  } catch {
    // Cannot tell. Report a non-zero count so the caller attempts the delete
    // rather than concluding there is nothing to delete.
    return 1;
  }
  // `undefined` is the only value that means "the key is absent, nothing to
  // delete". Anything else present -- a bare string, a number, `null`, a partial
  // object -- is bytes on disk the opt-out promise covers, so it must count as
  // at least one outstanding entry. Returning 0 for a non-object here would be
  // the same inversion that hid the live-vs-stored bug: treating the READER's
  // "serve nothing" as the DELETER's "nothing to delete".
  if (raw === undefined) return 0;
  if (typeof raw !== 'object' || raw === null) return 1;
  return Object.keys(raw as Record<string, unknown>).length;
}
