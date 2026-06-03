import { describe, it, expect } from 'vitest';
import { generateSessionReport, exportReportAsJSON, storeReport, getReports } from './report';
import type { AgentSession } from './types';
import type { AgentIdentity } from '../types/agent';
import type { AgentEvent } from '../types/events';

function makeAgent(type = 'playwright'): AgentIdentity {
  return {
    id: 'agent-1',
    type: type as AgentIdentity['type'],
    detectionMethods: ['cdp-connection'],
    confidence: 'high',
    detectedAt: '2026-01-01T10:00:00Z',
    originUrl: 'https://example.com',
    observedCapabilities: [],
    isActive: false,
  };
}

function makeEvent(overrides: Partial<AgentEvent> = {}): AgentEvent {
  return {
    id: 'event-1',
    type: 'action-allowed',
    timestamp: '2026-01-01T10:01:00Z',
    url: 'https://example.com/page',
    outcome: 'allowed',
    description: 'Test action',
    ...overrides,
  };
}

function makeSession(overrides: Partial<AgentSession> = {}): AgentSession {
  return {
    id: 'session-1',
    agent: makeAgent(),
    delegationRule: null,
    events: [],
    startedAt: '2026-01-01T10:00:00Z',
    endedAt: '2026-01-01T10:05:00Z',
    endReason: 'page-unload',
    summary: {
      totalActions: 0,
      allowedActions: 0,
      blockedActions: 0,
      violations: 0,
      topUrls: [],
      durationSeconds: 300,
    },
    ...overrides,
  };
}

describe('generateSessionReport', () => {
  it('generates a report from an empty session', () => {
    const session = makeSession();
    const report = generateSessionReport(session);

    expect(report.sessionId).toBe('session-1');
    expect(report.agentType).toBe('playwright');
    expect(report.durationSeconds).toBe(300);
    expect(report.actionSummary.total).toBe(0);
    expect(report.actionSummary.allowed).toBe(0);
    expect(report.actionSummary.blocked).toBe(0);
    expect(report.totalEvents).toBe(0);
    expect(report.violationsByCapability).toEqual({});
    expect(report.generatedAt).toBeTruthy();
  });

  it('counts event types correctly', () => {
    const events: AgentEvent[] = [
      makeEvent({ id: 'e1', type: 'detection', outcome: 'informational' }),
      makeEvent({ id: 'e2', type: 'action-allowed', outcome: 'allowed' }),
      makeEvent({ id: 'e3', type: 'action-blocked', outcome: 'blocked' }),
      makeEvent({ id: 'e4', type: 'action-allowed', outcome: 'allowed' }),
    ];

    const session = makeSession({
      events,
      summary: {
        totalActions: 3,
        allowedActions: 2,
        blockedActions: 1,
        violations: 0,
        topUrls: ['https://example.com/page'],
        durationSeconds: 300,
      },
    });

    const report = generateSessionReport(session);

    expect(report.totalEvents).toBe(4);
    expect(report.eventTypeCounts['detection']).toBe(1);
    expect(report.eventTypeCounts['action-allowed']).toBe(2);
    expect(report.eventTypeCounts['action-blocked']).toBe(1);
    expect(report.actionSummary.total).toBe(3);
    expect(report.actionSummary.allowed).toBe(2);
    expect(report.actionSummary.blocked).toBe(1);
  });

  it('counts violations by capability', () => {
    const events: AgentEvent[] = [
      makeEvent({ id: 'e1', type: 'boundary-violation', outcome: 'blocked', attemptedAction: 'navigate' }),
      makeEvent({ id: 'e2', type: 'boundary-violation', outcome: 'blocked', attemptedAction: 'navigate' }),
      makeEvent({ id: 'e3', type: 'boundary-violation', outcome: 'blocked', attemptedAction: 'submit-form' }),
    ];

    const session = makeSession({ events });
    const report = generateSessionReport(session);

    expect(report.violationsByCapability['navigate']).toBe(2);
    expect(report.violationsByCapability['submit-form']).toBe(1);
  });

  it('includes delegation rule summary', () => {
    const session = makeSession({
      delegationRule: {
        id: 'rule-1',
        preset: 'readOnly',
        agentId: null,
        scope: { sitePatterns: [], actionRestrictions: [], timeBound: null },
        createdAt: '2026-01-01T10:00:00Z',
        isActive: true,
      },
    });

    const report = generateSessionReport(session);
    expect(report.delegationRuleSummary).not.toBeNull();
    expect(report.delegationRuleSummary!.preset).toBe('readOnly');
    expect(report.delegationRuleSummary!.wasActive).toBe(true);
  });

  it('calculates duration from startedAt and endedAt', () => {
    const session = makeSession({
      startedAt: '2026-01-01T10:00:00Z',
      endedAt: '2026-01-01T10:10:00Z',
      summary: { totalActions: 0, allowedActions: 0, blockedActions: 0, violations: 0, topUrls: [], durationSeconds: null },
    });

    const report = generateSessionReport(session);
    expect(report.durationSeconds).toBe(600); // 10 minutes
  });

  it('handles session without endedAt', () => {
    const session = makeSession({
      endedAt: null,
      endReason: null,
      summary: { totalActions: 0, allowedActions: 0, blockedActions: 0, violations: 0, topUrls: [], durationSeconds: null },
    });

    const report = generateSessionReport(session);
    expect(report.durationSeconds).toBeNull();
    expect(report.endedAt).toBeNull();
    expect(report.endReason).toBeNull();
  });
});

describe('exportReportAsJSON', () => {
  it('exports a report as formatted JSON', () => {
    const session = makeSession();
    const report = generateSessionReport(session);
    const json = exportReportAsJSON(report);

    expect(json).toBeTruthy();
    const parsed = JSON.parse(json);
    expect(parsed.sessionId).toBe('session-1');
    expect(parsed.agentType).toBe('playwright');
  });
});

describe('storeReport / getReports', () => {
  it('stores and retrieves reports', async () => {
    const session = makeSession();
    const report = generateSessionReport(session);

    await storeReport(report);
    const reports = await getReports();

    expect(reports).toHaveLength(1);
    expect(reports[0].sessionId).toBe('session-1');
  });

  it('stores newest first', async () => {
    const report1 = generateSessionReport(makeSession({ id: 's1' }));
    const report2 = generateSessionReport(makeSession({ id: 's2' }));

    await storeReport(report1);
    await storeReport(report2);
    const reports = await getReports();

    expect(reports).toHaveLength(2);
    expect(reports[0].sessionId).toBe('s2');
    expect(reports[1].sessionId).toBe('s1');
  });

  it('limits stored reports to 20', async () => {
    for (let i = 0; i < 25; i++) {
      const report = generateSessionReport(makeSession({ id: `s${i}` }));
      await storeReport(report);
    }

    const reports = await getReports();
    expect(reports.length).toBeLessThanOrEqual(20);
  });
});
