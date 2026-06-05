/**
 * Registry contribution client.
 * Sends anonymized detection data to the OpenA2A trust registry.
 * Handles consent management, anonymization, batching, and offline queuing.
 */

import type { ContributeEvent, ContributeConsent, ContributeQueue } from './types';
import { DEFAULT_CONSENT, DEFAULT_QUEUE } from './types';

const CONSENT_KEY = 'contributeConsent';
const QUEUE_KEY = 'contributeQueue';
const CONTRIBUTOR_ID_KEY = 'contributorId';
const REGISTRY_CONTRIBUTE_URL = 'https://api.oa2a.org/api/v1/contribute';
const FLUSH_THRESHOLD = 10; // Flush after 10 events

/**
 * Get the anonymous contributor token, generating and persisting a random
 * per-install UUID on first use.
 *
 * Previously this derived the token from `chrome.runtime.id`, but the extension
 * ID is the same for every install of a published extension — so it identified
 * no one and provided no real dedup value. A random per-install UUID lets the
 * registry deduplicate submissions from one install without exposing any
 * stable, externally-derivable identifier.
 */
export async function getContributorToken(): Promise<string> {
  try {
    const result = await chrome.storage.local.get(CONTRIBUTOR_ID_KEY);
    const existing = result[CONTRIBUTOR_ID_KEY];
    if (typeof existing === 'string' && existing.length > 0) {
      return existing;
    }
    const token = `bg-${crypto.randomUUID()}`;
    await chrome.storage.local.set({ [CONTRIBUTOR_ID_KEY]: token });
    return token;
  } catch {
    // Storage/crypto unavailable in some contexts — fall back to a non-identifying constant.
    return 'anon-browserguard';
  }
}

/** Get the current consent state. */
export async function getConsent(): Promise<ContributeConsent> {
  try {
    const result = await chrome.storage.local.get(CONSENT_KEY);
    return { ...DEFAULT_CONSENT, ...(result[CONSENT_KEY] ?? {}) } as ContributeConsent;
  } catch {
    return { ...DEFAULT_CONSENT } as ContributeConsent;
  }
}

/** Save consent state. */
export async function saveConsent(consent: ContributeConsent): Promise<void> {
  await chrome.storage.local.set({ [CONSENT_KEY]: consent });
}

/** Enable contributions (user opted in). */
export async function enableContributions(): Promise<void> {
  const consent = await getConsent();
  consent.enabled = true;
  consent.grantedAt = new Date().toISOString();
  await saveConsent(consent);
}

/** Disable contributions (user opted out). */
export async function disableContributions(): Promise<void> {
  const consent = await getConsent();
  consent.enabled = false;
  await saveConsent(consent);
  // Clear the queue when disabling
  await saveQueue({ events: [], lastFlushedAt: null, totalFlushes: 0, totalContributed: 0 });
  // Drop the contributor token so a later opt-in mints a fresh one, preventing
  // cross-epoch linkage of submissions across an opt-out/opt-in cycle.
  try {
    await chrome.storage.local.remove(CONTRIBUTOR_ID_KEY);
  } catch {
    // Storage unavailable in some contexts -- non-critical.
  }
}

/** Record a detection for consent tip tracking. Returns true if the tip should now be shown. */
export async function recordDetection(): Promise<boolean> {
  const consent = await getConsent();
  consent.detectionsSinceInstall++;
  if (!consent.firstDetectionAt) {
    consent.firstDetectionAt = new Date().toISOString();
  }
  await saveConsent(consent);
  return shouldShowTip(consent);
}

/** Check if the delayed consent tip should be shown. */
export function shouldShowTip(consent: ContributeConsent): boolean {
  if (consent.enabled) return false; // Already opted in
  if (consent.tipDismissed) return false; // Already dismissed

  // Show after 5th detection
  if (consent.detectionsSinceInstall >= 5) return true;

  // Show after 3 days of use
  if (consent.firstDetectionAt) {
    const threeDaysMs = 3 * 24 * 60 * 60 * 1000;
    const elapsed = Date.now() - new Date(consent.firstDetectionAt).getTime();
    if (elapsed >= threeDaysMs) return true;
  }

  return false;
}

/** Dismiss the consent tip (user clicked dismiss, not enable). */
export async function dismissTip(): Promise<void> {
  const consent = await getConsent();
  consent.tipShown = true;
  consent.tipDismissed = true;
  await saveConsent(consent);
}

/** Get the event queue. */
export async function getQueue(): Promise<ContributeQueue> {
  try {
    const result = await chrome.storage.local.get(QUEUE_KEY);
    const stored = (result[QUEUE_KEY] ?? {}) as Partial<ContributeQueue>;
    return {
      events: stored.events ? [...stored.events] : [],
      lastFlushedAt: stored.lastFlushedAt ?? DEFAULT_QUEUE.lastFlushedAt,
      totalFlushes: stored.totalFlushes ?? DEFAULT_QUEUE.totalFlushes,
      totalContributed: stored.totalContributed ?? DEFAULT_QUEUE.totalContributed,
    };
  } catch {
    return { events: [], lastFlushedAt: null, totalFlushes: 0, totalContributed: 0 };
  }
}

/** Save the event queue. */
async function saveQueue(queue: ContributeQueue): Promise<void> {
  await chrome.storage.local.set({ [QUEUE_KEY]: queue });
}

/**
 * Queue a contribution event. If the queue reaches the flush threshold,
 * automatically flush to the registry.
 */
export async function queueEvent(event: ContributeEvent): Promise<void> {
  const consent = await getConsent();
  if (!consent.enabled) return; // Do not queue if not opted in

  const queue = await getQueue();
  queue.events.push(event);
  await saveQueue(queue);

  // Auto-flush if threshold reached
  if (queue.events.length >= FLUSH_THRESHOLD) {
    await flushQueue();
  }
}

/**
 * Flush the event queue to the Registry.
 * Sends batched events and clears the queue on success.
 * Silently fails on network error (events stay queued for retry).
 */
export async function flushQueue(): Promise<{ sent: number; success: boolean }> {
  const queue = await getQueue();
  if (queue.events.length === 0) {
    return { sent: 0, success: true };
  }

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };

  // Random per-install token: lets the registry deduplicate without identifying the user.
  const contributorToken = await getContributorToken();

  // Map internal events to the registry's expected schema.
  // The registry requires a `package` object with a non-empty `name` for all
  // event types. We use the detected framework as the package name.
  const toolVersion = chrome.runtime.getManifest?.()?.version ?? '0.0.0';
  const registryEvents = queue.events.map((event) => {
    const framework = (event.data as { framework?: string }).framework ?? 'unknown';
    return {
      type: event.type === 'detection_summary' ? 'detection' : 'behavior',
      tool: 'aibrowserguard',
      toolVersion,
      timestamp: event.timestamp,
      package: {
        name: framework,
        ecosystem: 'npm',
      },
      detectionSummary: event.type === 'detection_summary' ? {
        agentsFound: 1,
        mcpServersFound: 0,
        frameworkTypes: [framework],
      } : undefined,
      behaviorSummary: event.type === 'session_summary' ? {
        interactions: (event.data as { totalActions: number }).totalActions,
        successRate: (() => {
          const d = event.data as { totalActions: number; allowedActions: number };
          return d.totalActions > 0 ? d.allowedActions / d.totalActions : 1.0;
        })(),
        anomalies: (event.data as { violations: number }).violations,
      } : undefined,
    };
  });

  try {
    const response = await fetch(REGISTRY_CONTRIBUTE_URL, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        contributorToken,
        events: registryEvents,
        submittedAt: new Date().toISOString(),
      }),
    });

    if (response.ok) {
      const sentCount = queue.events.length;
      queue.totalContributed += sentCount;
      queue.totalFlushes++;
      queue.lastFlushedAt = new Date().toISOString();
      queue.events = []; // Clear sent events
      await saveQueue(queue);
      return { sent: sentCount, success: true };
    }

    // Non-2xx response -- keep events queued for retry
    return { sent: 0, success: false };
  } catch {
    // Network error -- keep events queued for retry
    return { sent: 0, success: false };
  }
}

/**
 * Get contribution statistics for display in the popup.
 */
export async function getContributeStats(): Promise<{
  totalContributed: number;
  queuedCount: number;
  lastFlushedAt: string | null;
  enabled: boolean;
}> {
  const [consent, queue] = await Promise.all([getConsent(), getQueue()]);
  return {
    totalContributed: queue.totalContributed,
    queuedCount: queue.events.length,
    lastFlushedAt: queue.lastFlushedAt,
    enabled: consent.enabled,
  };
}
