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

export interface OptOutResponse {
  /** Whether the settings write itself landed. */
  success: true;
  /**
   * Whether the stored declarations were actually deleted.
   *
   * Separate from `success` because they are different events. The setting can
   * save while the delete fails, and the two must not be conflated: reporting
   * `success: false` would claim the opt-out did not happen (it did, and no
   * further requests will be made), while a flat `success: true` would report
   * the privacy policy's promise — "turning the setting off deletes every
   * stored declaration" — as kept when it was not.
   */
  declarationsCleared: boolean;
}

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
