/**
 * The opt-out contract, tested by OUTCOME.
 *
 * An earlier version of this file asserted that background/index.ts *contained*
 * certain strings. That guard was worthless and this is the third round of the
 * same mistake in this feature: flipping the gate's `&&` to `||` (restoring the
 * bug where every unrelated toggle wiped the cache) and swapping the two
 * response branches (so a FAILED delete reports `declarationsCleared: true` —
 * exactly the "privacy promise reported as kept when it wasn't" bug the code
 * exists to prevent) both left the entire suite green, because the strings the
 * regexes matched were still there.
 *
 * A test that asserts code contains a rule cannot tell you the rule is correct.
 * The decision now lives in a pure module and is asserted by what it returns.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  shouldClearDeclarations,
  performOptOutClear,
  reconcileOptOut,
  reconcileFromSettings,
} from './optout';
import {
  clearAiSafetyCache,
  writeCachedLookup,
  getAiSafetyCacheSize,
  getStoredEntryCount,
} from './cache';
import {
  setDeclaration,
  clearInMemoryDeclarations,
  inMemoryDeclarationCount,
} from './declaration-store';
import type { AiSafetyLookupResult } from './types';

const OK: AiSafetyLookupResult = { status: 'ok', declaration: { aiSafe: true } };

/** Persist the consent flag the way readAiSafetyEnabledFlag reads it. */
async function setEnabled(value: boolean): Promise<void> {
  await chrome.storage.local.set({ settings: { aiSafetyTxtEnabled: value } });
}

beforeEach(async () => {
  await clearAiSafetyCache();
  // The store is a module singleton, not reset by the global storage reset.
  clearInMemoryDeclarations();
});

describe('shouldClearDeclarations', () => {
  it('clears when the user turns the flag OFF', () => {
    expect(
      shouldClearDeclarations({ aiSafetyTxtEnabled: false }, { aiSafetyTxtEnabled: false }),
    ).toBe(true);
  });

  it('does NOT clear when the user turns the flag ON', () => {
    // Kills the `||` mutation: with `touched || !enabled`, turning the feature
    // on would wipe the cache.
    expect(
      shouldClearDeclarations({ aiSafetyTxtEnabled: true }, { aiSafetyTxtEnabled: true }),
    ).toBe(false);
  });

  it.each([
    ['notifications', { notificationsEnabled: true }],
    ['cdp enforcement', { cdpEnforcementEnabled: true }],
    ['an empty payload', {}],
  ])('does NOT clear when the update only touched %s', (_label, updates) => {
    // The flag is OFF by default, so an unrelated toggle arrives with
    // `aiSafetyTxtEnabled: false` in the RESULTING settings. Gating on that
    // value alone fires a storage delete on every toggle in the panel — and,
    // now that the delete can fail loudly, lets an unrelated toggle report a
    // failure for a settings write that landed. This is the case the `||`
    // mutation breaks.
    expect(shouldClearDeclarations(updates, { aiSafetyTxtEnabled: false })).toBe(false);
  });

  it('is not fooled by an inherited property', () => {
    const updates = Object.create({ aiSafetyTxtEnabled: false }) as Record<string, unknown>;
    expect(shouldClearDeclarations(updates, { aiSafetyTxtEnabled: false })).toBe(false);
  });
});

describe('performOptOutClear', () => {
  it('reports declarationsCleared TRUE when the delete succeeds', async () => {
    expect(await performOptOutClear(async () => { /* ok */ })).toEqual({
      success: true,
      declarationsCleared: true,
    });
  });

  it('reports declarationsCleared FALSE when the delete fails', async () => {
    // Kills the swapped-branch mutation. Reporting `true` here would tell the
    // user their declarations were deleted while they are still on disk —
    // the privacy promise reported as kept when it was not.
    expect(
      await performOptOutClear(async () => {
        throw new Error('storage unavailable');
      }),
    ).toEqual({ success: true, declarationsCleared: false });
  });

  it('never reports the settings write as failed', async () => {
    // The setting has already saved by the time this runs. A delete failure
    // must not be reported as "could not save this setting".
    const result = await performOptOutClear(async () => {
      throw new Error('storage unavailable');
    });
    expect(result.success).toBe(true);
  });

  it('does not throw when the delete fails', async () => {
    await expect(
      performOptOutClear(async () => {
        throw new Error('boom');
      }),
    ).resolves.toBeDefined();
  });

  it('really does empty the cache when wired to the real clear', async () => {
    await writeCachedLookup('https://a.example', OK, 60_000);
    await writeCachedLookup('https://b.example', OK, 60_000);

    expect(await performOptOutClear(clearAiSafetyCache)).toEqual({
      success: true,
      declarationsCleared: true,
    });
    expect(await getAiSafetyCacheSize()).toBe(0);
  });

  it('reports FALSE when the real clear hits a storage failure', async () => {
    // End-to-end against the real clear: proves clearAiSafetyCache genuinely
    // rejects (it used to swallow, so the caller could never tell) AND that
    // performOptOutClear turns that into an honest report.
    const remove = chrome.storage.local.remove as unknown as ReturnType<typeof vi.fn>;
    const original = remove.getMockImplementation();
    remove.mockRejectedValueOnce(new Error('storage unavailable'));
    try {
      expect(await performOptOutClear(clearAiSafetyCache)).toEqual({
        success: true,
        declarationsCleared: false,
      });
    } finally {
      if (original) remove.mockImplementation(original);
    }
  });
});

describe('reconcileOptOut (runs at every service-worker start)', () => {
  it('deletes declarations left behind by a failed opt-out', async () => {
    // The scenario the popup cannot cover. The user opted out, the delete
    // failed, and they closed the popup — which took the warning and the retry
    // button with it, since both lived only in popup memory. Nothing else knew.
    // Without this, the declarations stay on disk forever and the privacy
    // policy's promise is permanently unfulfilled AND invisible.
    const clear = vi.fn(async () => { /* succeeds this time */ });

    const settled = await reconcileOptOut({
      enabled: false,
      storedCount: async () => 7,
      clear,
    });

    expect(settled).toBe(true);
    expect(clear).toHaveBeenCalledOnce();
  });

  it('does nothing when the user has opted back IN', async () => {
    // Also what makes a stale retry click safe: the button can outlive its
    // warning by one render, and clearing unconditionally would wipe the cache
    // of a feature the user just re-enabled.
    const clear = vi.fn(async () => { /* must not run */ });

    expect(await reconcileOptOut({ enabled: true, storedCount: async () => 7, clear })).toBe(true);
    expect(clear).not.toHaveBeenCalled();
  });

  it('does nothing when there is nothing stored', async () => {
    // The overwhelmingly common case: opted out, cache already empty. Must not
    // write to storage on every worker start.
    const clear = vi.fn(async () => { /* must not run */ });

    expect(await reconcileOptOut({ enabled: false, storedCount: async () => 0, clear })).toBe(true);
    expect(clear).not.toHaveBeenCalled();
  });

  it('reports NOT settled when the delete fails again', async () => {
    expect(
      await reconcileOptOut({
        enabled: false,
        storedCount: async () => 3,
        clear: async () => { throw new Error('storage still unavailable'); },
      }),
    ).toBe(false);
  });

  it('reports NOT settled when the cache cannot even be read', async () => {
    // Fails closed: an unreadable cache is not evidence that nothing is
    // outstanding.
    expect(
      await reconcileOptOut({
        enabled: false,
        storedCount: async () => { throw new Error('storage unavailable'); },
        clear: async () => { /* unreachable */ },
      }),
    ).toBe(false);
  });

  it('never throws when the CLEAR fails, so startup cannot break', async () => {
    // Distinct from the cache-unreadable case above: there, storedCount threw
    // first and the clear was never reached, so that test proved nothing about
    // a failing clear.
    await expect(
      reconcileOptOut({
        enabled: false,
        storedCount: async () => 5,
        clear: async () => { throw new Error('boom'); },
      }),
    ).resolves.toBe(false);
  });

  it('really empties the cache when wired to the real storage', async () => {
    await writeCachedLookup('https://a.example', OK, 60_000);
    await writeCachedLookup('https://b.example', OK, 60_000);

    const settled = await reconcileOptOut({
      enabled: false,
      storedCount: getStoredEntryCount,
      clear: clearAiSafetyCache,
    });

    expect(settled).toBe(true);
    // Asserted against RAW storage, not getAiSafetyCacheSize. That helper counts
    // only live entries, so it reports 0 for data that is still on disk -- the
    // exact blind spot that hid the expired-entry bug. A test that measures with
    // the broken ruler cannot detect the break.
    const stored = await chrome.storage.local.get('aiSafetyDeclarationCache');
    expect(stored.aiSafetyDeclarationCache).toBeUndefined();
  });
});

describe('expired-but-stored declarations are still deleted', () => {
  it('deletes entries that are on disk but past their TTL', async () => {
    // The bug this exists to prevent, and it was a real data-retention failure.
    //
    // The obligation is about BYTES ON DISK. Gating on the live/unexpired count
    // meant a failed opt-out delete resolved itself into "nothing outstanding"
    // the moment the TTL lapsed -- five minutes for an `unreachable` entry --
    // while the origins stayed on disk forever, because nothing purges them
    // while the user is opted out (readCache never writes back, and evict only
    // runs inside writeCachedLookup, which is gated off). The popup then told
    // the user the deletion had succeeded.
    vi.useFakeTimers();
    try {
      await writeCachedLookup('https://secret-site.example', { status: 'unreachable' }, 5 * 60_000);
      await writeCachedLookup('https://another.example', OK, 60_000);

      vi.advanceTimersByTime(24 * 60 * 60 * 1000); // everything now expired

      // The live count says there is nothing here...
      expect(await getAiSafetyCacheSize()).toBe(0);
      // ...but the origins are still on disk.
      expect(await getStoredEntryCount()).toBe(2);

      const settled = await reconcileOptOut({
        enabled: false,
        storedCount: getStoredEntryCount,
        clear: clearAiSafetyCache,
      });

      expect(settled).toBe(true);
      const stored = await chrome.storage.local.get('aiSafetyDeclarationCache');
      expect(stored.aiSafetyDeclarationCache).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('getStoredEntryCount counts bytes on disk, not what a reader would serve', async () => {
    vi.useFakeTimers();
    try {
      await writeCachedLookup('https://a.example', OK, 60_000);
      vi.advanceTimersByTime(60_000 + 1);

      expect(await getAiSafetyCacheSize()).toBe(0); // nothing servable
      expect(await getStoredEntryCount()).toBe(1); // still stored
    } finally {
      vi.useRealTimers();
    }
  });

  it('getStoredEntryCount counts a corrupt entry too', async () => {
    // An entry readCache would reject is still bytes on disk, and the deletion
    // promise covers it.
    await chrome.storage.local.set({ aiSafetyDeclarationCache: { 'https://x.example': 'garbage' } });
    expect(await getAiSafetyCacheSize()).toBe(0);
    expect(await getStoredEntryCount()).toBe(1);
  });

  it('getStoredEntryCount reports non-zero when storage cannot be read', async () => {
    // Fails toward attempting the delete rather than concluding there is
    // nothing to delete.
    const get = chrome.storage.local.get as unknown as ReturnType<typeof vi.fn>;
    const original = get.getMockImplementation();
    get.mockRejectedValueOnce(new Error('storage unavailable'));
    try {
      expect(await getStoredEntryCount()).toBeGreaterThan(0);
    } finally {
      if (original) get.mockImplementation(original);
    }
  });
});

describe('reconcileFromSettings (the wiring, tested by outcome)', () => {
  // Zero injected dependencies now. The consent read, the stored count, the
  // cache clear AND the in-memory clear are all bound by IMPORT, so these tests
  // drive the REAL settings read, the REAL cache, and the REAL in-memory store
  // against the chrome.storage mock -- the same code production runs. The two
  // miswirings that survived the whole suite (an always-`true` getSettings, and
  // a `clearInMemory: () => {}`) are no longer expressible: there is nothing to
  // pass.
  const OK_DECL = { origin: 'https://a.example', result: OK };

  async function seedTwoExpiredEntries() {
    vi.useFakeTimers();
    await writeCachedLookup('https://secret-site.example', { status: 'unreachable' }, 5 * 60_000);
    await writeCachedLookup('https://another.example', OK, 60_000);
    vi.advanceTimersByTime(24 * 60 * 60 * 1000);
  }

  it('deletes real stored data AND empties the in-memory store when opted out', async () => {
    await writeCachedLookup('https://a.example', OK, 60_000);
    setDeclaration(1, OK_DECL);
    await setEnabled(false);

    expect(await reconcileFromSettings()).toBe(true);

    const stored = await chrome.storage.local.get('aiSafetyDeclarationCache');
    expect(stored.aiSafetyDeclarationCache).toBeUndefined();
    // The in-memory clear is bound by import; asserted by outcome against the
    // real store, so `clearInMemory: () => {}` would leave this at 1.
    expect(inMemoryDeclarationCount()).toBe(0);
  });

  it('deletes real stored data that has EXPIRED', async () => {
    // The shipped bug, end to end through the wiring: the live count said zero
    // and the origins stayed on disk while the user was told deletion succeeded.
    try {
      await seedTwoExpiredEntries();
      // Premise: the data really is on disk. Without this assertion the whole
      // test also passes on an EMPTY cache (every check below is true of one),
      // so neutering the seed would not be caught. getAiSafetyCacheSize is the
      // misleading ruler that reads 0; getStoredEntryCount sees the bytes.
      expect(await getAiSafetyCacheSize()).toBe(0);
      expect(await getStoredEntryCount()).toBe(2);

      await setEnabled(false);
      expect(await reconcileFromSettings()).toBe(true);

      const stored = await chrome.storage.local.get('aiSafetyDeclarationCache');
      expect(stored.aiSafetyDeclarationCache).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('does NOT delete when the feature is enabled', async () => {
    // Kills the inverted-flag mutation, which deleted the cache when ENABLED and
    // never when opted out -- the exact inverse of the privacy contract.
    await writeCachedLookup('https://a.example', OK, 60_000);
    setDeclaration(1, OK_DECL);
    await setEnabled(true);

    expect(await reconcileFromSettings()).toBe(true);

    expect(await getStoredEntryCount()).toBe(1);
    expect(inMemoryDeclarationCount()).toBe(1); // in-memory untouched too
  });

  it('fails closed when the consent read REJECTS, keeping the opted-in cache', async () => {
    // The finding with real user impact. readAiSafetyEnabledFlag propagates a
    // storage failure instead of swallowing it into defaults, so a transient
    // error is "unknown" (do nothing) rather than "off" (delete). The old code
    // read through getSettings, which returns DEFAULT_STORAGE (flag false) on any
    // error, so this exact scenario deleted an opted-in user's cache.
    await writeCachedLookup('https://a.example', OK, 60_000);
    setDeclaration(1, OK_DECL);

    const get = chrome.storage.local.get as unknown as ReturnType<typeof vi.fn>;
    get.mockRejectedValueOnce(new Error('storage unavailable')); // hits the consent read first

    expect(await reconcileFromSettings()).toBe(false);
    expect(await getStoredEntryCount()).toBe(1); // cache untouched
    expect(inMemoryDeclarationCount()).toBe(1); // and nothing cleared on a guess
  });

  it('reports not settled when the real delete fails', async () => {
    await writeCachedLookup('https://a.example', OK, 60_000);
    await setEnabled(false);
    const remove = chrome.storage.local.remove as unknown as ReturnType<typeof vi.fn>;
    const original = remove.getMockImplementation();
    remove.mockRejectedValueOnce(new Error('storage unavailable'));
    try {
      expect(await reconcileFromSettings()).toBe(false);
    } finally {
      if (original) remove.mockImplementation(original);
    }
  });

  it('does not touch storage when opted out with an empty cache', async () => {
    await setEnabled(false);
    const set = chrome.storage.local.set as unknown as ReturnType<typeof vi.fn>;
    const remove = chrome.storage.local.remove as unknown as ReturnType<typeof vi.fn>;
    set.mockClear();
    remove.mockClear();

    expect(await reconcileFromSettings()).toBe(true);

    // Runs on every worker start and every 5-minute tick; it must not write.
    expect(set).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
  });
});
