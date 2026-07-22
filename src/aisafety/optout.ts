/**
 * The opt-out decision, extracted so it can be tested by outcome.
 *
 * This logic lived inline in the `SETTINGS_UPDATE` handler, which is inside the
 * background service worker — a side-effect module no test can import. The only
 * available guard was a regex over the source, and that guard was worthless:
 * flipping `&&` to `||` and swapping the two response branches both left the
 * whole suite green, because the strings the regexes looked for were still
 * present. A test that asserts code *contains* a rule cannot tell you the rule
 * is *correct*.
 *
 * So the decision lives here as two pure functions, and the handler is wiring.
 * Both mutations above now fail a test.
 */

import { getStoredEntryCount, clearAiSafetyCache } from './cache';
import { readAiSafetyEnabledFlag } from '../session/storage';
import { clearInMemoryDeclarations } from './declaration-store';
import type { OptOutResponse } from './opt-out-response';

// The wire shape and its pure readers live in the leaf `opt-out-response`
// module (no chrome/storage imports) so the popup can bind to them without
// pulling storage code into its bundle. Re-exported here so existing importers
// of the type keep working.
export type { OptOutResponse } from './opt-out-response';

/**
 * Whether a settings update should delete the stored declarations.
 *
 * True only when this update TOUCHED the flag and the result is off.
 *
 * Both halves matter. Gating on the value alone fires a storage delete on every
 * unrelated toggle, because the flag is off by default — and, since the delete
 * can now fail loudly, would let a Notifications toggle report a failure for a
 * settings write that landed. Gating on the payload alone would clear when the
 * user turns the feature ON.
 *
 * Reading the payload needs no remembered state, so unlike an edge check against
 * a cached previous value it cannot be wrong after a service-worker restart.
 */
export function shouldClearDeclarations(
  updates: Record<string, unknown>,
  nextSettings: { aiSafetyTxtEnabled: boolean },
): boolean {
  const touchedFlag = Object.prototype.hasOwnProperty.call(updates, 'aiSafetyTxtEnabled');
  return touchedFlag && !nextSettings.aiSafetyTxtEnabled;
}

/**
 * Run the opt-out delete and report what actually happened.
 *
 * Takes the clear as a parameter so a test can supply a failing one. Never
 * throws: a delete failure is a reportable outcome, not an error — the setting
 * has already saved by this point, and the caller must not turn that into
 * "saving failed".
 */
export async function performOptOutClear(clear: () => Promise<void>): Promise<OptOutResponse> {
  try {
    await clear();
    return { success: true, declarationsCleared: true };
  } catch {
    return { success: true, declarationsCleared: false };
  }
}

/**
 * Settle any outstanding deletion obligation: opted out, but declarations still
 * on disk.
 *
 * Run at every service-worker start, and by the popup's retry button.
 *
 * This exists because the obligation is DURABLE and the popup is not. If the
 * opt-out delete fails, the only thing that knew was a warning in popup memory,
 * which is rebuilt empty every time the popup opens — so closing and reopening
 * it lost the warning, lost the retry button, and left the declarations on disk
 * with nothing anywhere aware of it. The privacy policy's promise ("turning the
 * setting off deletes every stored declaration") would then be permanently
 * unfulfilled AND invisible. A durable obligation needs a durable check, so the
 * background re-checks on every start and the failure self-heals.
 *
 * Returns whether nothing is outstanding afterwards.
 */
export async function reconcileOptOut(deps: {
  /** Whether the user currently has the feature enabled. */
  enabled: boolean;
  /**
   * How many declarations are STORED — expired ones included.
   *
   * Must not be a live/unexpired count. Expired entries are still bytes on disk,
   * and while the user is opted out nothing ever purges them, so a live count
   * reports "nothing outstanding" as soon as the TTL lapses while the data is
   * still there. See `getStoredEntryCount`.
   */
  storedCount: () => Promise<number>;
  clear: () => Promise<void>;
}): Promise<boolean> {
  // The user has opted back in, so there is no deletion obligation. This is also
  // what makes a stale retry click safe: the button can outlive its warning by a
  // render, and without this check that click would wipe the cache of a feature
  // the user just re-enabled.
  if (deps.enabled) return true;

  try {
    if ((await deps.storedCount()) === 0) return true; // Nothing outstanding.
    await deps.clear();
    return true;
  } catch {
    return false;
  }
}

/**
 * The full reconcile, including reading the settings — the part that used to
 * live in the service worker and therefore had no test at all.
 *
 * Takes NO injected dependencies. Every input — the consent flag, the in-memory
 * clear, the stored count, the cache clear — is bound by IMPORT. This is the
 * point: "extract the decision so it can be tested" does not help if the caller
 * can still hand it the wrong thing, and this feature shipped exactly that. Two
 * injection points survived the whole suite AND tsc:
 *
 *   - `getSettings: async () => ({ ...real, aiSafetyTxtEnabled: true })` made the
 *     reconcile never delete anything;
 *   - `clearInMemory: () => {}` made in-memory declarations survive opt-out.
 *
 * With nothing to inject there is nothing to miswire, and the two remaining
 * behaviours are assertable by outcome against the real cache and the real
 * in-memory store (the chrome.storage mock is closer to production than a
 * hand-written fake anyway).
 *
 * The consent read is `readAiSafetyEnabledFlag`, which PROPAGATES a storage
 * failure. The previous version read through `getSettings`, which swallows every
 * error into defaults (flag `false`) — so its "fails closed" branch was dead
 * code (getSettings never rejected) and the real path failed OPEN: a transient
 * storage error looked like "opted out" and deleted an opted-in user's cache.
 * The bypass also avoids `getStorageState`'s per-read corruption rewrite on a
 * schema-downgraded profile.
 */
export async function reconcileFromSettings(): Promise<boolean> {
  let enabled: boolean;
  try {
    enabled = await readAiSafetyEnabledFlag();
  } catch {
    // Could not read consent. Do nothing rather than delete data on a guess, and
    // report not-settled so the obligation is retried on the next tick. THIS is
    // the branch the old "fails closed" comment claimed to be and was not.
    return false;
  }

  // Opted out, so nothing should be on screen either. Scoped to this branch on
  // purpose: clearing unconditionally would let a stale retry click — the button
  // can outlive its warning by one render — blank the declarations of a feature
  // the user has just re-enabled.
  if (!enabled) clearInMemoryDeclarations();

  return reconcileOptOut({
    enabled,
    storedCount: getStoredEntryCount,
    clear: clearAiSafetyCache,
  });
}
