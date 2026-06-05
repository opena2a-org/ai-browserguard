/**
 * Post-session report generation and storage.
 *
 * Generates structured reports from completed agent sessions,
 * summarizing the timeline, actions, violations, and delegation
 * rules that were in effect.
 */

import type { AgentSession, SessionSummary } from './types';
import type { AgentCapability } from '../types/agent';

/**
 * A complete post-session report.
 */
export interface SessionReport {
  /** Unique report identifier. */
  id: string;
  /** Reference to the session this report covers. */
  sessionId: string;
  /** ISO 8601 timestamp when the report was generated. */
  generatedAt: string;
  /** Agent type that was detected. */
  agentType: string;
  /** ISO 8601 timestamp when the session started. */
  startedAt: string;
  /** ISO 8601 timestamp when the session ended. */
  endedAt: string | null;
  /** How the session ended. */
  endReason: string | null;
  /** Duration of the session in seconds. */
  durationSeconds: number | null;
  /** Action summary counts. */
  actionSummary: {
    total: number;
    allowed: number;
    blocked: number;
  };
  /** Violation counts grouped by capability. */
  violationsByCapability: Record<string, number>;
  /** Most-visited URLs during the session (top 5). */
  topUrls: string[];
  /** Delegation rule that was active, if any. */
  delegationRuleSummary: {
    preset: string;
    wasActive: boolean;
  } | null;
  /** Total number of timeline events. */
  totalEvents: number;
  /** Timeline event type distribution. */
  eventTypeCounts: Record<string, number>;
  /** Network activity summary, if available. */
  networkSummary: {
    totalRequests: number;
    agentInitiated: number;
    userInitiated: number;
    uniqueDomains: number;
  } | null;
}

const MAX_STORED_REPORTS = 20;
const REPORTS_STORAGE_KEY = 'reports';
/** Reports older than this are pruned at write time (privacy retention TTL). */
const MAX_REPORT_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

/**
 * Generate a session report from a completed session.
 */
export function generateSessionReport(session: AgentSession): SessionReport {
  // Count violations by capability
  const violationsByCapability: Record<string, number> = {};
  const eventTypeCounts: Record<string, number> = {};

  for (const event of session.events) {
    // Track event type distribution
    eventTypeCounts[event.type] = (eventTypeCounts[event.type] ?? 0) + 1;

    // Count violations by attempted capability
    if (event.type === 'boundary-violation' && event.attemptedAction) {
      const cap = event.attemptedAction as string;
      violationsByCapability[cap] = (violationsByCapability[cap] ?? 0) + 1;
    }
  }

  // Calculate duration
  let durationSeconds: number | null = null;
  if (session.endedAt) {
    const start = new Date(session.startedAt).getTime();
    const end = new Date(session.endedAt).getTime();
    durationSeconds = Math.round((end - start) / 1000);
  } else if (session.summary.durationSeconds !== null) {
    durationSeconds = session.summary.durationSeconds;
  }

  // Build delegation rule summary
  let delegationRuleSummary: SessionReport['delegationRuleSummary'] = null;
  if (session.delegationRule) {
    delegationRuleSummary = {
      preset: session.delegationRule.preset,
      wasActive: session.delegationRule.isActive,
    };
  }

  // Build network summary from session if networkEvents are present
  let networkSummary: SessionReport['networkSummary'] = null;
  const sessionWithNetwork = session as AgentSession & { networkEvents?: Array<{ initiator: string; url: string }> };
  if (sessionWithNetwork.networkEvents && sessionWithNetwork.networkEvents.length > 0) {
    const events = sessionWithNetwork.networkEvents;
    const agentInitiated = events.filter(e => e.initiator === 'agent').length;
    const domains = new Set<string>();
    for (const e of events) {
      try {
        domains.add(new URL(e.url).hostname);
      } catch {
        // Skip invalid URLs
      }
    }
    networkSummary = {
      totalRequests: events.length,
      agentInitiated,
      userInitiated: events.length - agentInitiated,
      uniqueDomains: domains.size,
    };
  }

  return {
    id: crypto.randomUUID(),
    sessionId: session.id,
    generatedAt: new Date().toISOString(),
    agentType: session.agent.type,
    startedAt: session.startedAt,
    endedAt: session.endedAt,
    endReason: session.endReason,
    durationSeconds,
    actionSummary: {
      total: session.summary.totalActions,
      allowed: session.summary.allowedActions,
      blocked: session.summary.blockedActions,
    },
    violationsByCapability,
    topUrls: session.summary.topUrls,
    delegationRuleSummary,
    totalEvents: session.events.length,
    eventTypeCounts,
    networkSummary,
  };
}

/**
 * Store a report in chrome.storage.local.
 * Keeps only the most recent MAX_STORED_REPORTS reports.
 */
export async function storeReport(report: SessionReport): Promise<void> {
  try {
    const existing = await getReports();
    // Prune reports past the retention TTL so session data does not sit at rest
    // indefinitely. A malformed/absent generatedAt is treated as fresh (kept)
    // rather than dropped, so a parse glitch can never silently wipe history.
    const cutoff = Date.now() - MAX_REPORT_AGE_MS;
    const retained = existing.filter((r) => {
      const generated = Date.parse(r.generatedAt);
      return Number.isNaN(generated) || generated >= cutoff;
    });
    const updated = [report, ...retained];
    if (updated.length > MAX_STORED_REPORTS) {
      updated.length = MAX_STORED_REPORTS;
    }
    await chrome.storage.local.set({ [REPORTS_STORAGE_KEY]: updated });
  } catch (err) {
    console.error('[AI Browser Guard] Failed to store report:', err);
  }
}

/**
 * Retrieve all stored reports, newest first.
 */
export async function getReports(): Promise<SessionReport[]> {
  try {
    const result = await chrome.storage.local.get(REPORTS_STORAGE_KEY);
    return (result[REPORTS_STORAGE_KEY] as SessionReport[] | undefined) ?? [];
  } catch {
    return [];
  }
}

/**
 * Export a report as a formatted JSON string.
 */
export function exportReportAsJSON(report: SessionReport): string {
  return JSON.stringify(report, null, 2);
}
