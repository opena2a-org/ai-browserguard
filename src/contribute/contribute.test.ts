import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  getConsent,
  enableContributions,
  disableContributions,
  recordDetection,
  shouldShowTip,
  dismissTip,
  queueEvent,
  getQueue,
  getContributeStats,
  getContributorToken,
  flushQueue,
} from './client';
import { anonymizeDetection, anonymizeSession } from './anonymize';
import { DEFAULT_CONSENT, DEFAULT_QUEUE } from './types';
import type { ContributeConsent, ContributeEvent } from './types';
import type { DetectionEvent } from '../types/events';
import type { AgentSession } from '../session/types';

// Mock global fetch
const mockFetch = vi.fn();
(globalThis as Record<string, unknown>).fetch = mockFetch;

// Mock chrome.runtime.getManifest (not in base setup)
(chrome.runtime as Record<string, unknown>).getManifest = vi.fn(() => ({ version: '0.2.1' }));

beforeEach(() => {
  mockFetch.mockReset();
});

// -- Consent management --

describe('getConsent', () => {
  it('returns defaults when nothing stored', async () => {
    const consent = await getConsent();
    expect(consent).toEqual(DEFAULT_CONSENT);
    expect(consent.enabled).toBe(false);
    expect(consent.grantedAt).toBeNull();
    expect(consent.detectionsSinceInstall).toBe(0);
  });
});

describe('enableContributions', () => {
  it('sets enabled=true and grantedAt', async () => {
    await enableContributions();
    const consent = await getConsent();
    expect(consent.enabled).toBe(true);
    expect(consent.grantedAt).toBeTruthy();
    // grantedAt should be a valid ISO timestamp
    expect(new Date(consent.grantedAt!).toISOString()).toBe(consent.grantedAt);
  });
});

describe('disableContributions', () => {
  it('sets enabled=false and clears queue', async () => {
    // First enable and queue an event
    await enableContributions();
    const event: ContributeEvent = {
      type: 'detection_summary',
      timestamp: new Date().toISOString(),
      data: {
        framework: 'playwright',
        detectionMethods: ['cdp-connection'],
        confidence: 'high',
        hadDelegation: false,
      },
    };
    await queueEvent(event);

    // Now disable
    await disableContributions();
    const consent = await getConsent();
    expect(consent.enabled).toBe(false);

    // Queue should be cleared
    const queue = await getQueue();
    expect(queue.events).toHaveLength(0);
  });
});

// -- Detection recording and tip logic --

describe('recordDetection', () => {
  it('increments counter and returns false before 5th detection', async () => {
    let result: boolean;
    for (let i = 0; i < 4; i++) {
      result = await recordDetection();
    }
    // After 4 detections, should still be false
    expect(result!).toBe(false);

    const consent = await getConsent();
    expect(consent.detectionsSinceInstall).toBe(4);
    expect(consent.firstDetectionAt).toBeTruthy();
  });

  it('returns true on 5th detection', async () => {
    let result: boolean = false;
    for (let i = 0; i < 5; i++) {
      result = await recordDetection();
    }
    expect(result).toBe(true);
  });
});

describe('shouldShowTip', () => {
  it('returns false when already enabled', () => {
    const consent: ContributeConsent = {
      ...DEFAULT_CONSENT,
      enabled: true,
      detectionsSinceInstall: 10,
    };
    expect(shouldShowTip(consent)).toBe(false);
  });

  it('returns false when already dismissed', () => {
    const consent: ContributeConsent = {
      ...DEFAULT_CONSENT,
      tipDismissed: true,
      detectionsSinceInstall: 10,
    };
    expect(shouldShowTip(consent)).toBe(false);
  });

  it('returns true after 5 detections', () => {
    const consent: ContributeConsent = {
      ...DEFAULT_CONSENT,
      detectionsSinceInstall: 5,
    };
    expect(shouldShowTip(consent)).toBe(true);
  });

  it('returns true after 3 days', () => {
    const fourDaysAgo = new Date(Date.now() - 4 * 24 * 60 * 60 * 1000).toISOString();
    const consent: ContributeConsent = {
      ...DEFAULT_CONSENT,
      detectionsSinceInstall: 2, // Below threshold
      firstDetectionAt: fourDaysAgo,
    };
    expect(shouldShowTip(consent)).toBe(true);
  });

  it('returns false when under thresholds', () => {
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const consent: ContributeConsent = {
      ...DEFAULT_CONSENT,
      detectionsSinceInstall: 3,
      firstDetectionAt: oneHourAgo,
    };
    expect(shouldShowTip(consent)).toBe(false);
  });
});

describe('dismissTip', () => {
  it('sets tipDismissed=true', async () => {
    await dismissTip();
    const consent = await getConsent();
    expect(consent.tipDismissed).toBe(true);
    expect(consent.tipShown).toBe(true);
  });
});

// -- Queue management --

describe('queueEvent', () => {
  it('does nothing when not opted in', async () => {
    const event: ContributeEvent = {
      type: 'detection_summary',
      timestamp: new Date().toISOString(),
      data: {
        framework: 'playwright',
        detectionMethods: ['cdp-connection'],
        confidence: 'high',
        hadDelegation: false,
      },
    };
    await queueEvent(event);

    const queue = await getQueue();
    expect(queue.events).toHaveLength(0);
  });

  it('adds event to queue when opted in', async () => {
    await enableContributions();

    const event: ContributeEvent = {
      type: 'detection_summary',
      timestamp: new Date().toISOString(),
      data: {
        framework: 'selenium',
        detectionMethods: ['webdriver-flag'],
        confidence: 'confirmed',
        hadDelegation: true,
      },
    };
    await queueEvent(event);

    const queue = await getQueue();
    expect(queue.events).toHaveLength(1);
    expect(queue.events[0].type).toBe('detection_summary');
  });
});

// -- Contributor token --

describe('getContributorToken', () => {
  it('generates a random per-install token, not derived from the extension ID', async () => {
    const token = await getContributorToken();
    expect(token).toMatch(/^bg-/);
    // Must not be the old extension-ID-derived value.
    expect(token).not.toBe('bg-test-id');
  });

  it('persists and reuses the same token across calls', async () => {
    const first = await getContributorToken();
    const second = await getContributorToken();
    expect(second).toBe(first);
  });

  it('mints a fresh token after opt-out, preventing cross-epoch linkage', async () => {
    await enableContributions();
    const before = await getContributorToken();
    await disableContributions();
    const after = await getContributorToken();
    expect(after).not.toBe(before);
    expect(after).toMatch(/^bg-/);
  });

  it('sends the persisted token (not chrome.runtime.id) in the flush payload', async () => {
    const token = await getContributorToken();
    mockFetch.mockResolvedValueOnce({ ok: true, status: 200, json: () => Promise.resolve({ accepted: 1 }) });

    await enableContributions();
    await queueEvent({
      type: 'detection_summary',
      timestamp: new Date().toISOString(),
      data: { framework: 'playwright', detectionMethods: [], confidence: 'high', hadDelegation: false },
    });
    await flushQueue();

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const body = JSON.parse((mockFetch.mock.calls[0][1] as { body: string }).body);
    expect(body.contributorToken).toBe(token);
    expect(body.contributorToken).not.toBe('bg-test-id');
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

// -- Stats --

describe('getContributeStats', () => {
  it('returns correct values', async () => {
    // Start with defaults
    let stats = await getContributeStats();
    expect(stats.enabled).toBe(false);
    expect(stats.totalContributed).toBe(0);
    expect(stats.queuedCount).toBe(0);
    expect(stats.lastFlushedAt).toBeNull();

    // Enable and queue events
    await enableContributions();
    const event: ContributeEvent = {
      type: 'detection_summary',
      timestamp: new Date().toISOString(),
      data: {
        framework: 'playwright',
        detectionMethods: ['cdp-connection'],
        confidence: 'high',
        hadDelegation: false,
      },
    };
    await queueEvent(event);
    await queueEvent({ ...event, timestamp: new Date().toISOString() });

    stats = await getContributeStats();
    expect(stats.enabled).toBe(true);
    expect(stats.queuedCount).toBe(2);
    expect(stats.totalContributed).toBe(0); // Not flushed yet
  });
});
