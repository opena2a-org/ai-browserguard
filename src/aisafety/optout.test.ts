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
import { shouldClearDeclarations, performOptOutClear } from './optout';
import { clearAiSafetyCache, writeCachedLookup, getAiSafetyCacheSize } from './cache';
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
