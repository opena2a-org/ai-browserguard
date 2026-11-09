/**
 * Stored state of the contribution feature of earlier versions.
 *
 * The extension sends no contribution event and keeps no contribution queue,
 * contributor token or opt-in. Earlier versions kept a consent record, a queue
 * of events and a per-install contributor token in chrome.storage.local under
 * the keys below; the background worker removes them once, when the extension
 * is updated.
 */

/** The consent record, the event queue and the contributor token, in that order. */
export const STORED_CONTRIBUTION_KEYS = ['contributeConsent', 'contributeQueue', 'contributorId'] as const;

/** Remove the stored consent record, event queue and contributor token. */
export async function clearStoredContribution(): Promise<void> {
  await chrome.storage.local.remove([...STORED_CONTRIBUTION_KEYS]);
}
