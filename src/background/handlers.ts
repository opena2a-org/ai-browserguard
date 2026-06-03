/**
 * Pure handler functions for the background service worker.
 *
 * Extracted to allow unit testing without the side effects of index.ts
 * (chrome API listener registration, alarm creation, etc.).
 */

import type { BoundaryViolation } from '../types/events';
import type { DelegationRule } from '../types/delegation';
import type { BoundaryAlert } from '../alerts/boundary';
import { createBoundaryAlert } from '../alerts/boundary';
import { showBoundaryNotification } from '../alerts/notification';
import { createTimelineEvent, appendEventToSession } from '../session/timeline';
import { updateSession } from '../session/storage';

/**
 * Pending allow-once overrides keyed by notification ID.
 * Each entry holds the context needed to send the allow signal to the
 * correct content script when the user clicks "Allow once" in the notification.
 */
export interface PendingOverride {
  tabId: number;
  capability: string;
  url: string;
}

/**
 * Shared pending-overrides map used by both the background entry point and tests.
 */
export const pendingOverrides: Map<string, PendingOverride> = new Map();

/**
 * Process a boundary violation:
 *  1. Create a BoundaryAlert from the violation and the active rule.
 *  2. Show a Chrome notification.
 *  3. If the notification was created and tabId is known, store a pending override
 *     so that clicking "Allow once" can relay the signal back to the content script.
 *
 * Returns the created BoundaryAlert so callers can add it to their state.
 */
export function processBoundaryViolation(
  tabId: number | undefined,
  violation: BoundaryViolation,
  activeRule: DelegationRule,
  activeSessions: Map<number, string>,
  notificationsEnabled = true
): BoundaryAlert {
  const alert = createBoundaryAlert(violation, activeRule);

  // Honor the user's "Notifications" setting. When disabled, no Chrome
  // notification is shown (showBoundaryNotification returns null), but the
  // timeline event, badge, and in-page toast paths still run.
  const notificationId = showBoundaryNotification(alert, { enabled: notificationsEnabled });

  // Store the pending override so the notification button handler can act on it.
  if (notificationId !== null && tabId !== undefined) {
    pendingOverrides.set(notificationId, {
      tabId,
      capability: violation.attemptedAction,
      url: violation.url,
    });
  }

  // Log the violation as a timeline event if we have a session for this tab.
  if (tabId !== undefined) {
    const sessionId = activeSessions.get(tabId);
    if (sessionId) {
      const event = createTimelineEvent(
        'boundary-violation',
        violation.url,
        `Violation: ${violation.attemptedAction} blocked`,
        {
          attemptedAction: violation.attemptedAction,
          outcome: 'blocked',
          ruleId: violation.blockingRuleId,
          targetSelector: violation.targetSelector,
        }
      );
      updateSession(sessionId, (session) => appendEventToSession(session, event)).catch(
        () => { /* ignore */ }
      );
    }
  }

  return alert;
}

/**
 * Handle a user's "Allow once" click:
 *  1. Look up the pending override by notificationId.
 *  2. Send an ALLOW_ONCE message to the content script in the originating tab.
 *  3. Remove the entry from pendingOverrides.
 *
 * Returns true if an override was found and the message was dispatched, false otherwise.
 */
export async function handleAllowOnce(notificationId: string): Promise<boolean> {
  const override = pendingOverrides.get(notificationId);
  if (!override) return false;

  pendingOverrides.delete(notificationId);

  try {
    await chrome.tabs.sendMessage(override.tabId, {
      type: 'ALLOW_ONCE',
      data: { capability: override.capability, url: override.url },
      sentAt: new Date().toISOString(),
    });
  } catch {
    // The tab may have been closed before the user clicked "Allow once".
  }

  // Clear the notification itself so it dismisses after the user acts.
  try {
    chrome.notifications.clear(notificationId);
  } catch {
    // Notification may already be gone.
  }

  return true;
}
