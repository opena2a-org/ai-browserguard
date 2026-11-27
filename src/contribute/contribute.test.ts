import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { chromeMock, storageData } from '../__tests__/setup';
import { anonymizeDetection, anonymizeSession } from './anonymize';
import type { DetectionEvent } from '../types/events';
import type { AgentSession } from '../session/types';

// -- Stored contribution state from an earlier version --

/**
 * What an earlier version kept in storage with contribution turned on: the
 * consent record, a queue holding a batch not yet sent, and the per-install
 * contributor token.
 */
function seedEarlierContributionState(): void {
  storageData.contributeConsent = {
    enabled: true,
    grantedAt: '2026-01-01T00:00:00.000Z',
    tipShown: true,
    tipDismissed: false,
    detectionsSinceInstall: 7,
    firstDetectionAt: '2026-01-01T00:00:00.000Z',
  };
  storageData.contributeQueue = {
    events: [
      {
        type: 'detection_summary',
        timestamp: '2026-01-02T00:00:00.000Z',
        data: { framework: 'playwright', detectionMethods: ['cdp-connection'], confidence: 'high', hadDelegation: false },
      },
    ],
    lastFlushedAt: '2026-01-01T12:00:00.000Z',
    totalFlushes: 1,
    totalContributed: 10,
  };
  storageData.contributorId = 'bg-00000000-0000-4000-8000-000000000000';
}

function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

async function settleAll(): Promise<void> {
  for (let i = 0; i < 10; i++) await settle();
}

async function startWorker(): Promise<void> {
  vi.resetModules();
  await import('../background/index');
  await settleAll();
}

const fetchDouble = vi.fn((): Promise<unknown> => Promise.reject(new Error('no request expected')));
const originalFetch = (globalThis as Record<string, unknown>).fetch;

describe('stored contribution state from an earlier version', () => {
  beforeEach(() => {
    fetchDouble.mockClear();
    (globalThis as Record<string, unknown>).fetch = fetchDouble;
  });

  afterEach(() => {
    (globalThis as Record<string, unknown>).fetch = originalFetch;
  });

  it('holds no queue, contributor token or consent record once the extension is updated', async () => {
    seedEarlierContributionState();
    storageData.settings = { registryLookupEnabled: true };

    await startWorker();
    chromeMock.runtime.onInstalled._fire({ reason: 'update', previousVersion: '0.7.0' });
    await settleAll();

    expect(storageData.contributeQueue).toBeUndefined();
    expect(storageData.contributorId).toBeUndefined();
    expect(storageData.contributeConsent).toBeUndefined();
    // Only those keys go: the user's settings stay as they were.
    expect((storageData.settings as { registryLookupEnabled?: boolean }).registryLookupEnabled).toBe(true);
    // Clearing sends nothing first.
    expect(fetchDouble).not.toHaveBeenCalled();
  });

  it('retries a rejected removal on the next worker start', async () => {
    seedEarlierContributionState();
    chromeMock.storage.local.remove.mockImplementationOnce(() => Promise.reject(new Error('storage busy')));

    await startWorker();
    chromeMock.runtime.onInstalled._fire({ reason: 'update', previousVersion: '0.7.0' });
    await settleAll();

    await startWorker();

    expect(storageData.contributeQueue).toBeUndefined();
    expect(storageData.contributorId).toBeUndefined();
    expect(storageData.contributeConsent).toBeUndefined();
  });

  it('retries a rejected removal on the housekeeping alarm', async () => {
    await startWorker();
    seedEarlierContributionState();
    // Earlier tests' workers keep their listeners, so reject every removal
    // for the duration of the update event.
    const realRemove = chromeMock.storage.local.remove.getMockImplementation()!;
    chromeMock.storage.local.remove.mockImplementation(() => Promise.reject(new Error('storage busy')));
    chromeMock.runtime.onInstalled._fire({ reason: 'update', previousVersion: '0.7.0' });
    await settleAll();
    chromeMock.storage.local.remove.mockImplementation(realRemove);
    expect(storageData.contributorId).toBeDefined();

    chromeMock.alarms.onAlarm._fire({ name: 'contribute-flush' });
    await settleAll();

    expect(storageData.contributeQueue).toBeUndefined();
    expect(storageData.contributorId).toBeUndefined();
    expect(storageData.contributeConsent).toBeUndefined();
  });
});

// -- Anonymization --

describe('anonymizeDetection', () => {
  it('strips URLs and keeps framework and methods', () => {
    const detection: DetectionEvent = {
      id: 'det-1',
      timestamp: '2026-03-20T10:00:00.000Z',
      methods: ['cdp-connection', 'framework-fingerprint'],
      confidence: 'high',
      agent: {
        id: 'agent-1',
        type: 'playwright',
        detectionMethods: ['cdp-connection', 'framework-fingerprint'],
        confidence: 'high',
        detectedAt: '2026-03-20T10:00:00.000Z',
        originUrl: 'https://secret-internal-site.company.com/admin',
        observedCapabilities: ['navigate', 'click'],
        isActive: true,
      },
      url: 'https://secret-internal-site.company.com/admin',
      signals: { webdriver: true, cdpMarkers: ['Runtime.enable'] },
    };

    const result = anonymizeDetection(detection, true);

    expect(result.type).toBe('detection_summary');
    expect(result.timestamp).toBeTruthy();
    expect(result.data).toEqual({
      framework: 'playwright',
      detectionMethods: ['cdp-connection', 'framework-fingerprint'],
      confidence: 'high',
      hadDelegation: true,
    });

    // Verify no URL data leaked into the contribution
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('secret-internal-site');
    expect(serialized).not.toContain('company.com');
    expect(serialized).not.toContain('admin');
  });

  it('uses "unknown" when agent is null', () => {
    const detection: DetectionEvent = {
      id: 'det-2',
      timestamp: '2026-03-20T10:00:00.000Z',
      methods: ['behavioral-timing'],
      confidence: 'low',
      agent: null,
      url: 'https://example.com',
      signals: {},
    };

    const result = anonymizeDetection(detection, false);
    expect((result.data as { framework: string }).framework).toBe('unknown');
  });
});

describe('anonymizeSession', () => {
  it('strips URLs and selectors, keeps counts and framework', () => {
    const session: AgentSession = {
      id: 'session-1',
      agent: {
        id: 'agent-1',
        type: 'puppeteer',
        detectionMethods: ['cdp-connection'],
        confidence: 'confirmed',
        detectedAt: '2026-03-20T10:00:00.000Z',
        originUrl: 'https://banking.example.com/accounts',
        observedCapabilities: ['navigate', 'click', 'type-text'],
        isActive: false,
      },
      delegationRule: {
        id: 'rule-1',
        preset: 'limited',
        agentId: null,
        scope: {
          sitePatterns: [
            { pattern: '*.example.com', action: 'allow' },
            { pattern: '*.bank.com', action: 'block' },
          ],
          actionRestrictions: [
            { capability: 'navigate', action: 'allow' },
            { capability: 'read-dom', action: 'allow' },
          ],
          timeBound: {
            durationMinutes: 60,
            grantedAt: '2026-03-20T09:00:00.000Z',
            expiresAt: '2026-03-20T10:00:00.000Z',
          },
        },
        createdAt: '2026-03-20T09:00:00.000Z',
        isActive: false,
        label: 'Test Rule',
      },
      events: [
        {
          id: 'evt-1',
          type: 'action-allowed',
          timestamp: '2026-03-20T10:01:00.000Z',
          url: 'https://banking.example.com/accounts',
          targetSelector: '#account-balance',
          attemptedAction: 'navigate',
          outcome: 'allowed',
          description: 'Navigation to accounts page',
        },
        {
          id: 'evt-2',
          type: 'action-blocked',
          timestamp: '2026-03-20T10:02:00.000Z',
          url: 'https://banking.example.com/transfer',
          targetSelector: '#transfer-form button[type=submit]',
          attemptedAction: 'submit-form',
          outcome: 'blocked',
          description: 'Form submission blocked',
          ruleId: 'rule-1',
        },
        {
          id: 'evt-3',
          type: 'action-allowed',
          timestamp: '2026-03-20T10:03:00.000Z',
          url: 'https://banking.example.com/accounts',
          attemptedAction: 'click',
          outcome: 'allowed',
          description: 'Click on element',
        },
      ],
      startedAt: '2026-03-20T10:00:00.000Z',
      endedAt: '2026-03-20T10:05:00.000Z',
      endReason: 'delegation-expired',
      summary: {
        totalActions: 3,
        allowedActions: 2,
        blockedActions: 1,
        violations: 1,
        topUrls: ['https://banking.example.com/accounts', 'https://banking.example.com/transfer'],
        durationSeconds: 300,
      },
    };

    const result = anonymizeSession(session);

    expect(result.type).toBe('session_summary');
    expect(result.timestamp).toBeTruthy();
    expect(result.data).toEqual({
      framework: 'puppeteer',
      durationSeconds: 300,
      totalActions: 3,
      allowedActions: 2,
      blockedActions: 1,
      violations: 1,
      endReason: 'delegation-expired',
      hadDelegation: true,
      actionTypes: ['navigate', 'submit-form', 'click'],
    });

    // Verify no URL or selector data leaked
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('banking.example.com');
    expect(serialized).not.toContain('#account-balance');
    expect(serialized).not.toContain('#transfer-form');
    expect(serialized).not.toContain('accounts');
  });

  it('handles session with no endedAt', () => {
    const session: AgentSession = {
      id: 'session-2',
      agent: {
        id: 'agent-2',
        type: 'selenium',
        detectionMethods: ['webdriver-flag'],
        confidence: 'high',
        detectedAt: '2026-03-20T10:00:00.000Z',
        originUrl: 'https://example.com',
        observedCapabilities: [],
        isActive: true,
      },
      delegationRule: null,
      events: [],
      startedAt: '2026-03-20T10:00:00.000Z',
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
    };

    const result = anonymizeSession(session);
    expect((result.data as { durationSeconds: number }).durationSeconds).toBe(0);
    expect((result.data as { hadDelegation: boolean }).hadDelegation).toBe(false);
    expect((result.data as { endReason: string }).endReason).toBe('unknown');
  });
});
