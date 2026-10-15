/**
 * Session timeline management.
 *
 * Maintains a chronological log of agent actions per session.
 * Each entry records what happened, where, and whether it was allowed.
 */

import type { AgentEvent, AgentEventType, DownloadEventAttribution } from '../types/events';
import type { AgentCapability } from '../types/agent';
import type { AgentSession, SessionSummary } from './types';

function generateId(): string {
  return crypto.randomUUID();
}

/**
 * Reduce a URL to its hostname for at-rest storage.
 *
 * Full URLs can carry tokens or usernames in the path or query, so the
 * persisted/exported `topUrls` keeps only the hostname (mirrors the
 * hostname-only treatment of `networkSummary.uniqueDomains`). Returns null
 * for malformed URLs so they are dropped rather than stored verbatim.
 */
function toHostname(url: string): string | null {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

/**
 * Create a new timeline event.
 */
export function createTimelineEvent(
  type: AgentEventType,
  url: string,
  description: string,
  options?: {
    targetSelector?: string;
    attemptedAction?: AgentCapability;
    outcome?: 'allowed' | 'blocked' | 'informational';
    ruleId?: string;
    attribution?: DownloadEventAttribution;
  }
): AgentEvent {
  return {
    id: generateId(),
    type,
    timestamp: new Date().toISOString(),
    url,
    description,
    outcome: options?.outcome ?? 'informational',
    targetSelector: options?.targetSelector,
    attemptedAction: options?.attemptedAction,
    ruleId: options?.ruleId,
    // Only download events carry it; every other event keeps its old shape.
    ...(options?.attribution ? { attribution: options.attribution } : {}),
  };
}

/**
 * The most events, other than 'detection' entries, one session keeps. A tab's
 * session stays open for as long as the tab does, and an agent can act in it
 * any number of times, so past this the oldest of those events are dropped.
 * The background worker caps a session's 'detection' entries separately.
 */
export const MAX_SESSION_EVENTS = 200;

/** The most characters of an event's URL that a session stores. */
export const MAX_STORED_URL_LENGTH = 1024;

/** The most characters of an event's target selector that a session stores. */
export const MAX_STORED_SELECTOR_LENGTH = 256;

/** `text` cut to `max` characters, the last of them an ellipsis, when it is longer. */
function capLength(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/**
 * A page address as it is stored: cut to MAX_STORED_URL_LENGTH characters, the
 * last of them an ellipsis, when it is longer. The page sets its own address,
 * query string included, with no length limit.
 */
export function capStoredUrl(url: string): string {
  return capLength(url, MAX_STORED_URL_LENGTH);
}

type SummaryCount = 'totalActions' | 'allowedActions' | 'blockedActions' | 'violations';

const SUMMARY_COUNTS: SummaryCount[] = ['totalActions', 'allowedActions', 'blockedActions', 'violations'];

/**
 * Append an event to a session's timeline and recalculate summary.
 *
 * The page sets an event's URL and target selector (its address, an element's
 * id) with no length limit, so they are stored cut to MAX_STORED_URL_LENGTH and
 * MAX_STORED_SELECTOR_LENGTH characters. Past MAX_SESSION_EVENTS events other
 * than 'detection' entries, the oldest of those are dropped. The summary's
 * counts still include the dropped events: what the session's summary counted
 * beyond its stored events is carried over.
 */
export function appendEventToSession(
  session: AgentSession,
  event: AgentEvent
): AgentSession {
  const stored: AgentEvent = {
    ...event,
    ...(typeof event.url === 'string' ? { url: capStoredUrl(event.url) } : {}),
    ...(typeof event.targetSelector === 'string'
      ? { targetSelector: capLength(event.targetSelector, MAX_STORED_SELECTOR_LENGTH) }
      : {}),
  };
  const all = [...session.events, stored];
  const summary = computeSessionSummary(all, session.startedAt);
  const listed = computeSessionSummary(session.events, session.startedAt);
  for (const count of SUMMARY_COUNTS) {
    summary[count] += Math.max(0, (session.summary?.[count] ?? 0) - listed[count]);
  }

  const others = all.filter((e) => e.type !== 'detection');
  const dropped = new Set(others.slice(0, Math.max(0, others.length - MAX_SESSION_EVENTS)));
  const events = dropped.size > 0 ? all.filter((e) => !dropped.has(e)) : all;
  return { ...session, events, summary };
}

/**
 * Compute summary statistics from a session's event timeline.
 */
export function computeSessionSummary(
  events: AgentEvent[],
  startedAt: string
): SessionSummary {
  let totalActions = 0;
  let allowedActions = 0;
  let blockedActions = 0;
  let violations = 0;
  const urlCounts = new Map<string, number>();

  for (const event of events) {
    if (event.outcome === 'allowed') {
      totalActions++;
      allowedActions++;
    } else if (event.outcome === 'blocked') {
      totalActions++;
      blockedActions++;
    }
    if (event.type === 'boundary-violation') {
      violations++;
    }
    if (event.url) {
      // Count by hostname only — full URLs are never persisted in the summary.
      const host = toHostname(event.url);
      if (host) {
        urlCounts.set(host, (urlCounts.get(host) ?? 0) + 1);
      }
    }
  }

  const topUrls = [...urlCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([host]) => host);

  let durationSeconds: number | null = null;
  if (events.length > 0) {
    const lastEvent = events[events.length - 1];
    const start = new Date(startedAt).getTime();
    const end = new Date(lastEvent.timestamp).getTime();
    durationSeconds = Math.round((end - start) / 1000);
  }

  return {
    totalActions,
    allowedActions,
    blockedActions,
    violations,
    topUrls,
    durationSeconds,
  };
}

/**
 * Filter timeline events by type, URL, or outcome.
 */
export function filterTimelineEvents(
  events: AgentEvent[],
  filters: {
    type?: AgentEventType;
    url?: string;
    outcome?: 'allowed' | 'blocked' | 'informational';
  }
): AgentEvent[] {
  return events.filter((event) => {
    if (filters.type !== undefined && event.type !== filters.type) return false;
    if (filters.url !== undefined && event.url !== filters.url) return false;
    if (filters.outcome !== undefined && event.outcome !== filters.outcome) return false;
    return true;
  });
}

/**
 * Get the most recent N events, newest first.
 */
export function getRecentEvents(events: AgentEvent[], count: number): AgentEvent[] {
  return events.slice(-count).reverse();
}
