/**
 * Regression test for #30 finding #3: the kill switch must end sessions that
 * survived a service-worker restart.
 *
 * After an MV3 service-worker restart the in-memory activeSessions map is empty,
 * but sessions persisted to storage still carry `endedAt: null`. Ending sessions
 * off the in-memory map skips those, so they never receive `endReason:'kill-switch'`
 * and no report is generated. `endStoredSessionsForKillSwitch` drives the teardown
 * off STORED sessions instead.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import '../__tests__/setup';
import { endStoredSessionsForKillSwitch } from './kill-switch-sessions';
import { saveSession, getSessions, clearAllStorage } from '../session/storage';
import { generateSessionReport, storeReport, getReports } from '../session/report';
import type { AgentSession } from '../session/types';

function makeSession(id: string, overrides?: Partial<AgentSession>): AgentSession {
  return {
    id,
    agent: {
      id: 'agent-' + id,
      type: 'unknown',
      detectionMethods: [],
      confidence: 'low',
      detectedAt: new Date().toISOString(),
      originUrl: 'https://example.com',
      observedCapabilities: [],
      isActive: true,
    },
    delegationRule: null,
    events: [],
    startedAt: new Date().toISOString(),
    endedAt: null,
    endReason: null,
    summary: {
      totalActions: 0,
      allowedActions: 0,
      blockedActions: 0,
      violations: 0,
      topUrls: [],
      durationSeconds: null,
    },
    ...overrides,
  };
}

// A faithful stand-in for the background's generateAndStoreReport: only stores a
// report for a session that storage now reports as ended.
async function generateReportFromStorage(sessionId: string): Promise<void> {
  const sessions = await getSessions();
  const session = sessions.find((s) => s.id === sessionId);
  if (session && session.endedAt) {
    await storeReport(generateSessionReport(session));
  }
}

describe('endStoredSessionsForKillSwitch', () => {
  beforeEach(async () => {
    await clearAllStorage();
  });

  it('ends a stored session that survived a service-worker restart (in-memory map empty)', async () => {
    // Seed storage as if the session was persisted before the SW was torn down.
    await saveSession(makeSession('survivor'));

    // Simulate the restart: the in-memory map is empty, so the teardown can only
    // see this session via storage.
    const ended = await endStoredSessionsForKillSwitch(generateReportFromStorage);

    expect(ended).toEqual(['survivor']);

    const sessions = await getSessions();
    const survivor = sessions.find((s) => s.id === 'survivor');
    expect(survivor?.endedAt).not.toBeNull();
    expect(survivor?.endReason).toBe('kill-switch');

    const reports = await getReports();
    expect(reports.some((r) => r.sessionId === 'survivor')).toBe(true);
  });

  it('does not re-end or duplicate reports for already-ended sessions', async () => {
    await saveSession(
      makeSession('already-ended', {
        endedAt: '2026-06-01T00:00:00.000Z',
        endReason: 'page-unload',
      }),
    );

    const generateReport = vi.fn(generateReportFromStorage);
    const ended = await endStoredSessionsForKillSwitch(generateReport);

    expect(ended).toEqual([]);
    expect(generateReport).not.toHaveBeenCalled();

    const sessions = await getSessions();
    const session = sessions.find((s) => s.id === 'already-ended');
    // Reason and timestamp preserved — not overwritten by the kill switch.
    expect(session?.endReason).toBe('page-unload');
    expect(session?.endedAt).toBe('2026-06-01T00:00:00.000Z');
  });

  it('ends only the un-ended sessions in a mixed set', async () => {
    await saveSession(makeSession('open-1'));
    await saveSession(
      makeSession('closed', { endedAt: '2026-06-01T00:00:00.000Z', endReason: 'agent-disconnected' }),
    );
    await saveSession(makeSession('open-2'));

    const ended = await endStoredSessionsForKillSwitch(generateReportFromStorage);

    expect(new Set(ended)).toEqual(new Set(['open-1', 'open-2']));

    const sessions = await getSessions();
    expect(sessions.find((s) => s.id === 'closed')?.endReason).toBe('agent-disconnected');
    expect(sessions.find((s) => s.id === 'open-1')?.endReason).toBe('kill-switch');
    expect(sessions.find((s) => s.id === 'open-2')?.endReason).toBe('kill-switch');
  });

  it('stamps endedAt from the injected clock', async () => {
    await saveSession(makeSession('clock'));
    const fixed = '2026-06-03T12:00:00.000Z';

    await endStoredSessionsForKillSwitch(generateReportFromStorage, () => fixed);

    const sessions = await getSessions();
    expect(sessions.find((s) => s.id === 'clock')?.endedAt).toBe(fixed);
  });
});
