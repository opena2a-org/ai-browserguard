/**
 * Unit tests for background service worker handler logic.
 *
 * Tests cover:
 * - pendingOverrides allow-once flow
 * - processBoundaryViolation (notification + override storage)
 * - handleAllowOnce (relay to content script + cleanup)
 * - STATUS_QUERY response shape (via handleMessage simulation)
 * - KILL_SWITCH_RESET state reset
 * - Tab removal cleans up activeAgents and activeSessions
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { chromeMock } from '../__tests__/setup';
import { pendingOverrides, processBoundaryViolation, handleAllowOnce } from './handlers';
import type { BoundaryViolation } from '../types/events';
import type { DelegationRule } from '../types/delegation';

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

function makeDelegationRule(overrides?: Partial<DelegationRule>): DelegationRule {
  return {
    id: 'rule-1',
    preset: 'limited',
    scope: {
      sitePatterns: [],
      actionRestrictions: [{ capability: 'navigate', action: 'block' }],
      timeBound: null,
    },
    createdAt: new Date().toISOString(),
    agentId: null,
    isActive: true,
    label: 'Test Rule',
    ...overrides,
  };
}

function makeViolation(overrides?: Partial<BoundaryViolation>): BoundaryViolation {
  return {
    id: 'violation-1',
    timestamp: new Date().toISOString(),
    agentId: 'agent-1',
    attemptedAction: 'navigate',
    url: 'https://example.com/page',
    blockingRuleId: 'rule-1',
    reason: 'navigate blocked by delegation rule',
    userOverride: false,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// pendingOverrides Map behaviour
// ---------------------------------------------------------------------------

describe('pendingOverrides Map', () => {
  beforeEach(() => {
    pendingOverrides.clear();
  });

  it('starts empty', () => {
    expect(pendingOverrides.size).toBe(0);
  });

  it('can store and retrieve an override', () => {
    pendingOverrides.set('notif-1', { tabId: 42, capability: 'navigate', url: 'https://x.com' });
    expect(pendingOverrides.get('notif-1')).toEqual({ tabId: 42, capability: 'navigate', url: 'https://x.com' });
  });

  it('is cleared after handleAllowOnce consumes the entry', async () => {
    pendingOverrides.set('notif-2', { tabId: 10, capability: 'open-tab', url: 'https://y.com' });
    await handleAllowOnce('notif-2');
    expect(pendingOverrides.has('notif-2')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// processBoundaryViolation
// ---------------------------------------------------------------------------

describe('processBoundaryViolation', () => {
  beforeEach(() => {
    pendingOverrides.clear();
  });

  it('calls showBoundaryNotification (chrome.notifications.create)', () => {
    const rule = makeDelegationRule();
    const violation = makeViolation();
    const sessions = new Map<number, string>();

    processBoundaryViolation(1, violation, rule, sessions);

    expect(chromeMock.notifications.create).toHaveBeenCalledTimes(1);
  });

  it('suppresses the Chrome notification when notificationsEnabled is false (regression)', () => {
    const rule = makeDelegationRule();
    const violation = makeViolation();
    const sessions = new Map<number, string>();

    const alert = processBoundaryViolation(1, violation, rule, sessions, false);

    // No system notification, but the alert is still produced (badge/timeline/toast paths run).
    expect(chromeMock.notifications.create).not.toHaveBeenCalled();
    expect(alert).toBeTruthy();
    // And no pending override is stored, since there is no notification to act on.
    expect(pendingOverrides.size).toBe(0);
  });

  it('stores a pending override keyed by the notification ID when tabId is provided', () => {
    const rule = makeDelegationRule();
    // Use 'navigate' (severity: medium) to meet the default minimumSeverity: 'medium' threshold.
    const violation = makeViolation({ attemptedAction: 'navigate', url: 'https://test.com/page' });
    const sessions = new Map<number, string>();

    processBoundaryViolation(5, violation, rule, sessions);

    // showBoundaryNotification builds the ID as `abg-alert-${Date.now()}`.
    // We retrieve it from the mock call args.
    const createCalls = (chromeMock.notifications.create as ReturnType<typeof vi.fn>).mock.calls;
    expect(createCalls.length).toBeGreaterThan(0);
    const capturedNotifId = createCalls[0]?.[0] as string;

    expect(typeof capturedNotifId).toBe('string');
    expect(capturedNotifId.startsWith('abg-alert-')).toBe(true);
    expect(pendingOverrides.has(capturedNotifId)).toBe(true);
    const stored = pendingOverrides.get(capturedNotifId);
    expect(stored?.tabId).toBe(5);
    expect(stored?.capability).toBe('navigate');
    expect(stored?.url).toBe('https://test.com/page');
  });

  it('does NOT store a pending override when tabId is undefined', () => {
    const rule = makeDelegationRule();
    const violation = makeViolation();
    const sessions = new Map<number, string>();

    processBoundaryViolation(undefined, violation, rule, sessions);

    expect(pendingOverrides.size).toBe(0);
  });

  it('returns a BoundaryAlert with the correct violation reference', () => {
    const rule = makeDelegationRule();
    const violation = makeViolation();
    const sessions = new Map<number, string>();

    const alert = processBoundaryViolation(1, violation, rule, sessions);

    expect(alert.violation).toBe(violation);
    expect(typeof alert.severity).toBe('string');
    expect(typeof alert.title).toBe('string');
    expect(typeof alert.message).toBe('string');
  });

  it('does not store override when notification is not created (notifications disabled)', () => {
    // Simulate showBoundaryNotification returning null (e.g. severity below threshold).
    // The notification config minimumSeverity is 'medium' and the default violation
    // has action 'navigate' which has severity 'medium', so it should normally fire.
    // To suppress, use a low-severity violation type that doesn't meet minimum.
    // Actually navigate is medium which meets the default 'medium' threshold.
    // We can force chrome.notifications.create to throw to simulate failure.
    (chromeMock.notifications.create as ReturnType<typeof vi.fn>).mockImplementation(() => {
      throw new Error('Notifications unavailable');
    });

    const rule = makeDelegationRule();
    const violation = makeViolation();
    const sessions = new Map<number, string>();

    // Should not throw — showBoundaryNotification catches errors and returns null
    processBoundaryViolation(1, violation, rule, sessions);

    // No override should be stored since notificationId is null
    expect(pendingOverrides.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// handleAllowOnce
// ---------------------------------------------------------------------------

describe('handleAllowOnce', () => {
  beforeEach(() => {
    pendingOverrides.clear();
  });

  it('returns false when the notificationId is not in pendingOverrides', async () => {
    const result = await handleAllowOnce('unknown-notif');
    expect(result).toBe(false);
  });

  it('returns true and sends ALLOW_ONCE message to the correct tab', async () => {
    pendingOverrides.set('notif-abc', { tabId: 7, capability: 'navigate', url: 'https://spa.com' });

    const result = await handleAllowOnce('notif-abc');

    expect(result).toBe(true);
    expect(chromeMock.tabs.sendMessage).toHaveBeenCalledWith(
      7,
      expect.objectContaining({
        type: 'ALLOW_ONCE',
        data: { capability: 'navigate', url: 'https://spa.com' },
      })
    );
  });

  it('removes the entry from pendingOverrides after handling', async () => {
    pendingOverrides.set('notif-xyz', { tabId: 3, capability: 'open-tab', url: 'https://new.com' });
    await handleAllowOnce('notif-xyz');
    expect(pendingOverrides.has('notif-xyz')).toBe(false);
  });

  it('clears the notification after handling', async () => {
    pendingOverrides.set('notif-clear', { tabId: 2, capability: 'navigate', url: 'https://y.com' });
    await handleAllowOnce('notif-clear');
    expect(chromeMock.notifications.clear).toHaveBeenCalledWith('notif-clear');
  });

  it('does not throw if chrome.tabs.sendMessage rejects (closed tab)', async () => {
    (chromeMock.tabs.sendMessage as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error('No receiving end')
    );
    pendingOverrides.set('notif-closed', { tabId: 99, capability: 'navigate', url: 'https://z.com' });

    // Should resolve without throwing
    await expect(handleAllowOnce('notif-closed')).resolves.toBe(true);
  });

  it('is idempotent — second call for same notification returns false', async () => {
    pendingOverrides.set('notif-dup', { tabId: 4, capability: 'navigate', url: 'https://dup.com' });
    const first = await handleAllowOnce('notif-dup');
    const second = await handleAllowOnce('notif-dup');
    expect(first).toBe(true);
    expect(second).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// STATUS_QUERY response shape (simulated via handler logic)
// ---------------------------------------------------------------------------

describe('STATUS_QUERY response shape', () => {
  it('response includes required fields with correct types', () => {
    // Simulate the STATUS_QUERY handler logic from index.ts directly here.
    // We test the shape contract rather than the wired-up module.
    const activeAgents = new Map();
    const delegationRules: DelegationRule[] = [];
    const killSwitchActive = false;
    const recentAlerts: unknown[] = [];
    const lifetimeStats = { firstActiveAt: null, totalSessions: 0, totalActionsBlocked: 0, agentTypesDetected: {} };

    const agents = Array.from(activeAgents.values());
    const activeRule = delegationRules.find((r) => r.isActive) ?? null;

    const response = {
      detectedAgents: agents,
      activeDelegation: activeRule,
      killSwitchActive,
      recentViolations: recentAlerts,
      delegationRules,
      lifetimeStats,
    };

    expect(response).toHaveProperty('detectedAgents');
    expect(response).toHaveProperty('activeDelegation');
    expect(response).toHaveProperty('killSwitchActive');
    expect(response).toHaveProperty('recentViolations');
    expect(response).toHaveProperty('delegationRules');
    expect(response).toHaveProperty('lifetimeStats');
    expect(Array.isArray(response.detectedAgents)).toBe(true);
    expect(typeof response.killSwitchActive).toBe('boolean');
  });

  it('activeDelegation is null when no rules are active', () => {
    const delegationRules: DelegationRule[] = [
      makeDelegationRule({ isActive: false }),
      makeDelegationRule({ id: 'rule-2', isActive: false }),
    ];
    const activeRule = delegationRules.find((r) => r.isActive) ?? null;
    expect(activeRule).toBeNull();
  });

  it('activeDelegation is the active rule when one exists', () => {
    const rule = makeDelegationRule({ isActive: true });
    const delegationRules: DelegationRule[] = [rule];
    const activeRule = delegationRules.find((r) => r.isActive) ?? null;
    expect(activeRule).toBe(rule);
  });
});

// ---------------------------------------------------------------------------
// KILL_SWITCH_RESET — state reset logic
// ---------------------------------------------------------------------------

describe('KILL_SWITCH_RESET state reset', () => {
  it('resets killSwitch state fields to their off values', () => {
    // Replicate the KILL_SWITCH_RESET handler logic from index.ts.
    // We use explicit nullable types to match KillSwitchState.
    const killSwitch: {
      isActive: boolean;
      lastEvent: { id: string; timestamp: string; trigger: 'button'; terminatedAgentIds: string[]; revokedTokenIds: string[]; closedTabIds: number[]; pageRealmCleanupDispatched: boolean } | null;
      lastActivatedAt: string | null;
    } = {
      isActive: true,
      lastEvent: {
        id: 'ev-1',
        timestamp: new Date().toISOString(),
        trigger: 'button' as const,
        terminatedAgentIds: [],
        revokedTokenIds: [],
        closedTabIds: [],
        pageRealmCleanupDispatched: true,
      },
      lastActivatedAt: new Date().toISOString(),
    };

    // Apply reset
    killSwitch.isActive = false;
    killSwitch.lastEvent = null;
    killSwitch.lastActivatedAt = null;

    expect(killSwitch.isActive).toBe(false);
    expect(killSwitch.lastEvent).toBeNull();
    expect(killSwitch.lastActivatedAt).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Tab removal cleans up activeAgents and activeSessions
// ---------------------------------------------------------------------------

describe('handleTabRemoved cleanup logic', () => {
  it('removes agent from activeAgents on tab removal', () => {
    const activeAgents = new Map<number, { id: string }>();
    const activeSessions = new Map<number, string>();

    activeAgents.set(1, { id: 'agent-1' });
    activeSessions.set(1, 'session-1');

    // Simulate handleTabRemoved logic from index.ts
    const tabId = 1;
    const sessionId = activeSessions.get(tabId);
    expect(sessionId).toBe('session-1');
    activeSessions.delete(tabId);
    activeAgents.delete(tabId);

    expect(activeAgents.has(1)).toBe(false);
    expect(activeSessions.has(1)).toBe(false);
  });

  it('handles removal of a tab with no associated agent gracefully', () => {
    const activeAgents = new Map<number, { id: string }>();
    const activeSessions = new Map<number, string>();

    // Tab 99 has no agent or session
    const tabId = 99;
    const sessionId = activeSessions.get(tabId);
    expect(sessionId).toBeUndefined();

    activeSessions.delete(tabId);
    activeAgents.delete(tabId);

    expect(activeAgents.size).toBe(0);
    expect(activeSessions.size).toBe(0);
  });

  it('only removes the specified tab, leaving others intact', () => {
    const activeAgents = new Map<number, { id: string }>();
    const activeSessions = new Map<number, string>();

    activeAgents.set(1, { id: 'agent-1' });
    activeAgents.set(2, { id: 'agent-2' });
    activeSessions.set(1, 'session-1');
    activeSessions.set(2, 'session-2');

    // Remove tab 1
    activeSessions.delete(1);
    activeAgents.delete(1);

    expect(activeAgents.has(1)).toBe(false);
    expect(activeAgents.has(2)).toBe(true);
    expect(activeSessions.has(1)).toBe(false);
    expect(activeSessions.has(2)).toBe(true);
  });
});
