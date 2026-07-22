/**
 * The wire shape the popup receives after an ai-safety.txt opt-out or a retry,
 * plus the pure readers the popup uses to interpret it.
 *
 * A leaf module on purpose: no chrome, no storage, no cache imports. Two reasons
 * follow from that:
 *
 *   1. The popup can import these readers without dragging the service worker's
 *      storage code into its bundle.
 *   2. A rename of a field is a COMPILE error in the readers here, not a silent
 *      `undefined` at an inline cast in the popup. That silent cast is exactly
 *      how "the shape cannot drift from what the popup reads" turned out to be
 *      false: the popup cast the response inline and never imported the type, so
 *      tsc had nothing to check, and renaming `declarationsCleared` would have
 *      left the popup reading `undefined` forever with a green build.
 */

export interface OptOutResponse {
  /**
   * Whether the settings write itself landed. Always `true` on this shape: by
   * the time an opt-out delete runs, the setting has already saved, so a delete
   * outcome is never a settings-write failure. A failed settings write is a
   * different response (`{ success: false }`) that never carries a delete flag.
   */
  success: true;
  /**
   * Whether the stored declarations were actually deleted. Separate from
   * `success` because they are different events: the setting can save while the
   * delete fails, and reporting the privacy policy's promise ("turning the
   * setting off deletes every stored declaration") as kept when it was not is
   * the exact failure this flag exists to surface.
   */
  declarationsCleared: boolean;
}

/**
 * Shape the retry (AI_SAFETY_CLEAR) response from a settled flag.
 *
 * `settled` is "nothing is outstanding afterwards" -- true when the delete
 * succeeded OR there was nothing to delete, false when it failed again. Pure and
 * tested by outcome, so flipping it (`declarationsCleared: !settled`) fails a
 * test instead of silently telling the user their data is gone when it is not.
 */
export function optOutRetryResponse(settled: boolean): OptOutResponse {
  return { success: true, declarationsCleared: settled };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * Read `declarationsCleared` off a response, keeping the field NAME bound to
 * `OptOutResponse` (via the `Partial<OptOutResponse>` cast) so a rename is a
 * compile error here rather than an undefined read in the popup.
 */
function readDeclarationsCleared(response: unknown): boolean | undefined {
  if (!isRecord(response)) return undefined;
  const cleared = (response as Partial<OptOutResponse>).declarationsCleared;
  return typeof cleared === 'boolean' ? cleared : undefined;
}

/** True only when a settings write explicitly reported failure. */
export function settingsWriteFailed(response: unknown): boolean {
  // Not typed against OptOutResponse: its `success` is the literal `true`, and a
  // failed settings write is the distinct `{ success: false }` shape.
  return isRecord(response) && response.success === false;
}

/** True only when the response says the declaration delete failed. */
export function declarationDeleteFailed(response: unknown): boolean {
  return readDeclarationsCleared(response) === false;
}

/** True only when the response says the declarations were deleted. */
export function declarationsWereCleared(response: unknown): boolean {
  return readDeclarationsCleared(response) === true;
}
