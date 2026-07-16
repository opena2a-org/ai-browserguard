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
import type { AiSafetyLookupResult } from './types';

const OK: AiSafetyLookupResult = { status: 'ok', declaration: { aiSafe: true } };

beforeEach(async () => {
  await clearAiSafetyCache();
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
  // Drives the REAL cache against the chrome.storage mock. The counter and the
  // clear used to be injected, and the only caller lived in the service worker,
  // so "pass the live count instead of the stored count" was a miswiring no test
  // could reach -- and it is the bug that shipped. They are bound inside
  // reconcileFromSettings now, so these tests exercise the same code production
  // does rather than a fake that cannot be wrong.
  async function seedTwoExpiredEntries() {
    vi.useFakeTimers();
    await writeCachedLookup('https://secret-site.example', { status: 'unreachable' }, 5 * 60_000);
    await writeCachedLookup('https://another.example', OK, 60_000);
    vi.advanceTimersByTime(24 * 60 * 60 * 1000);
  }

  it('deletes real stored data when opted out', async () => {
    await writeCachedLookup('https://a.example', OK, 60_000);
    const clearInMemory = vi.fn();

    expect(
      await reconcileFromSettings({
        getSettings: async () => ({ aiSafetyTxtEnabled: false }),
        clearInMemory,
      }),
    ).toBe(true);

    const stored = await chrome.storage.local.get('aiSafetyDeclarationCache');
    expect(stored.aiSafetyDeclarationCache).toBeUndefined();
    expect(clearInMemory).toHaveBeenCalledOnce();
  });

  it('deletes real stored data that has EXPIRED', async () => {
    // The shipped bug, end to end through the wiring: the live count said zero
    // and the origins stayed on disk while the user was told deletion succeeded.
    try {
      await seedTwoExpiredEntries();
      expect(await getAiSafetyCacheSize()).toBe(0); // the misleading ruler

      expect(
        await reconcileFromSettings({
          getSettings: async () => ({ aiSafetyTxtEnabled: false }),
          clearInMemory: vi.fn(),
        }),
      ).toBe(true);

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
    const clearInMemory = vi.fn();

    expect(
      await reconcileFromSettings({
        getSettings: async () => ({ aiSafetyTxtEnabled: true }),
        clearInMemory,
      }),
    ).toBe(true);

    expect(await getStoredEntryCount()).toBe(1);
    expect(clearInMemory).not.toHaveBeenCalled();
  });

  it('fails closed when the settings read returns null', async () => {
    await writeCachedLookup('https://a.example', OK, 60_000);
    expect(
      await reconcileFromSettings({ getSettings: async () => null, clearInMemory: vi.fn() }),
    ).toBe(false);
    expect(await getStoredEntryCount()).toBe(1); // untouched
  });

  it('fails closed when the settings read rejects', async () => {
    await writeCachedLookup('https://a.example', OK, 60_000);
    expect(
      await reconcileFromSettings({
        getSettings: async () => { throw new Error('storage unavailable'); },
        clearInMemory: vi.fn(),
      }),
    ).toBe(false);
    expect(await getStoredEntryCount()).toBe(1); // untouched
  });

  it('reports not settled when the real delete fails', async () => {
    await writeCachedLookup('https://a.example', OK, 60_000);
    const remove = chrome.storage.local.remove as unknown as ReturnType<typeof vi.fn>;
    const original = remove.getMockImplementation();
    remove.mockRejectedValueOnce(new Error('storage unavailable'));
    try {
      expect(
        await reconcileFromSettings({
          getSettings: async () => ({ aiSafetyTxtEnabled: false }),
          clearInMemory: vi.fn(),
        }),
      ).toBe(false);
    } finally {
      if (original) remove.mockImplementation(original);
    }
  });

  it('does not touch storage when opted out with an empty cache', async () => {
    const set = chrome.storage.local.set as unknown as ReturnType<typeof vi.fn>;
    const remove = chrome.storage.local.remove as unknown as ReturnType<typeof vi.fn>;
    set.mockClear();
    remove.mockClear();

    expect(
      await reconcileFromSettings({
        getSettings: async () => ({ aiSafetyTxtEnabled: false }),
        clearInMemory: vi.fn(),
      }),
    ).toBe(true);

    // Runs on every worker start and every 5-minute tick; it must not write.
    expect(set).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
  });
});
