/**
 * Chrome notification integration for boundary alerts.
 *
 * Delivers system-level notifications when agents violate delegation
 * boundaries.
 */

import type { BoundaryAlert, AlertSeverity } from './boundary';

export interface NotificationConfig {
  enabled: boolean;
  minimumSeverity: AlertSeverity;
  playSound: boolean;
  autoDismissMs: number;
}

export const DEFAULT_NOTIFICATION_CONFIG: NotificationConfig = {
  enabled: true,
  minimumSeverity: 'medium',
  playSound: true,
  autoDismissMs: 10000,
};

/**
 * Show a Chrome notification for a boundary alert.
 */
export function showBoundaryNotification(
  alert: BoundaryAlert,
  config?: Partial<NotificationConfig>
): string | null {
  const mergedConfig = { ...DEFAULT_NOTIFICATION_CONFIG, ...config };

  if (!mergedConfig.enabled) return null;
  if (!meetsSeverityThreshold(alert.severity, mergedConfig.minimumSeverity)) return null;

  const notificationId = `abg-alert-${Date.now()}`;

  try {
    const options: chrome.notifications.NotificationOptions<true> = {
      type: 'basic' as const,
      iconUrl: chrome.runtime.getURL('icons/icon128.png'),
      title: `AI Browser Guard - ${alert.title}`,
      message: alert.message,
      priority: severityToPriority(alert.severity),
      requireInteraction: alert.severity === 'critical',
    };

    if (alert.allowOneTimeOverride) {
      options.buttons = [
        { title: 'Allow once' },
        { title: 'Dismiss' },
      ];
    }

    chrome.notifications.create(notificationId, options);

    if (mergedConfig.autoDismissMs > 0 && alert.severity !== 'critical') {
      setTimeout(() => {
        try {
          chrome.notifications.clear(notificationId);
        } catch {
          // Notification may already be cleared
        }
      }, mergedConfig.autoDismissMs);
    }
  } catch (err) {
    console.error('[AI Browser Guard] Failed to create notification:', err);
    return null;
  }

  return notificationId;
}

/**
 * Show a notification about something the guard recorded and did not stop.
 * It has no buttons, since there is nothing to allow or undo, and honours the
 * same Notifications setting and auto-dismiss as a boundary alert.
 */
export function showNoticeNotification(
  title: string,
  message: string,
  config?: Partial<Pick<NotificationConfig, 'enabled' | 'autoDismissMs'>>
): string | null {
  const mergedConfig = { ...DEFAULT_NOTIFICATION_CONFIG, ...config };
  if (!mergedConfig.enabled) return null;

  const notificationId = `abg-notice-${Date.now()}`;

  try {
    chrome.notifications.create(notificationId, {
      type: 'basic' as const,
      iconUrl: chrome.runtime.getURL('icons/icon128.png'),
      title: `AI Browser Guard - ${title}`,
      message,
      priority: 0,
    });

    if (mergedConfig.autoDismissMs > 0) {
      setTimeout(() => {
        try {
          chrome.notifications.clear(notificationId);
        } catch {
          // Notification may already be cleared
        }
      }, mergedConfig.autoDismissMs);
    }
  } catch (err) {
    console.error('[AI Browser Guard] Failed to create notification:', err);
    return null;
  }

  return notificationId;
}

/**
 * Map alert severity to notification priority.
 */
export function severityToPriority(severity: AlertSeverity): number {
  const priorityMap: Record<AlertSeverity, number> = {
    critical: 2,
    high: 1,
    medium: 0,
    low: 0,
  };
  return priorityMap[severity];
}

/**
 * Check if a severity meets the minimum threshold.
 */
export function meetsSeverityThreshold(
  severity: AlertSeverity,
  minimum: AlertSeverity
): boolean {
  const order: AlertSeverity[] = ['low', 'medium', 'high', 'critical'];
  return order.indexOf(severity) >= order.indexOf(minimum);
}

/**
 * Set up notification button click handlers.
 */
export function setupNotificationHandlers(
  onAllowOnce: (notificationId: string) => void
): () => void {
  const handler = (notificationId: string, buttonIndex: number) => {
    if (buttonIndex === 0) {
      // "Allow once"
      onAllowOnce(notificationId);
    }
    // Button 1 = "Dismiss" - just clear
    try {
      chrome.notifications.clear(notificationId);
    } catch {
      // Ignore
    }
  };

  chrome.notifications.onButtonClicked.addListener(handler);

  return () => {
    chrome.notifications.onButtonClicked.removeListener(handler);
  };
}

/**
 * Clear all active notifications.
 */
export async function clearAllNotifications(): Promise<void> {
  return new Promise<void>((resolve) => {
    try {
      chrome.notifications.getAll((notifications) => {
        for (const id of Object.keys(notifications)) {
          chrome.notifications.clear(id);
        }
        resolve();
      });
    } catch {
      resolve();
    }
  });
}
