import { describe, it, expect } from 'vitest';
import { selectEffectiveRule, applyDelegationUpdate, ruleScopeKey } from './effective';
import type { DelegationRule } from '../types/delegation';

function makeRule(overrides?: Partial<DelegationRule>): DelegationRule {
  return {
    id: 'rule-' + Math.random().toString(36).slice(2),
    preset: 'readOnly',
    agentId: null,
    scope: { sitePatterns: [], actionRestrictions: [], timeBound: null },
    createdAt: '2026-01-01T00:00:00Z',
    isActive: true,
    ...overrides,
  };
}

function expiredBound() {
  return {
    durationMinutes: 60,
    grantedAt: '2026-01-01T00:00:00Z',
    expiresAt: '2026-01-01T01:00:00Z', // far in the past
  };
}

describe('selectEffectiveRule', () => {
  it('returns the rule bound to the tab agent', () => {
    const rules = [makeRule({ id: 'a', agentId: 'agent-A', preset: 'fullAccess' })];
    expect(selectEffectiveRule(rules, 'agent-A')?.id).toBe('a');
  });

  it('does NOT apply agent A grant to agent B (the core #27 bug)', () => {
    const rules = [makeRule({ id: 'a', agentId: 'agent-A', preset: 'fullAccess' })];
    // Agent B has no rule of its own and there is no session-wide rule.
    expect(selectEffectiveRule(rules, 'agent-B')).toBeNull();
  });

  it('falls back to the session-wide rule when the agent has none', () => {
    const rules = [
      makeRule({ id: 'session', agentId: null, preset: 'readOnly' }),
      makeRule({ id: 'a', agentId: 'agent-A', preset: 'fullAccess' }),
    ];
    expect(selectEffectiveRule(rules, 'agent-B')?.id).toBe('session');
  });

  it('prefers a per-agent rule over the session-wide rule in the agent tab', () => {
    const rules = [
      makeRule({ id: 'session', agentId: null }),
      makeRule({ id: 'a', agentId: 'agent-A', preset: 'fullAccess' }),
    ];
    expect(selectEffectiveRule(rules, 'agent-A')?.id).toBe('a');
  });

  it('ignores inactive and expired rules', () => {
    const rules = [
      makeRule({ id: 'inactive', agentId: 'agent-A', isActive: false }),
      makeRule({ id: 'expired', agentId: 'agent-A', scope: { sitePatterns: [], actionRestrictions: [], timeBound: expiredBound() } }),
    ];
    expect(selectEffectiveRule(rules, 'agent-A')).toBeNull();
  });

  it('returns null when no agent is active and no session-wide rule exists', () => {
    const rules = [makeRule({ id: 'a', agentId: 'agent-A' })];
    expect(selectEffectiveRule(rules, null)).toBeNull();
  });
});

describe('applyDelegationUpdate', () => {
  it("granting agent A leaves agent B's active grant untouched (isolation)", () => {
    const ruleB = makeRule({ id: 'b', agentId: 'agent-B', preset: 'readOnly' });
    const ruleA = makeRule({ id: 'a', agentId: 'agent-A', preset: 'fullAccess' });
    const next = applyDelegationUpdate([ruleB], ruleA);

    expect(next.find((r) => r.id === 'b')?.isActive).toBe(true);
    expect(next.find((r) => r.id === 'a')?.isActive).toBe(true);
    expect(selectEffectiveRule(next, 'agent-B')?.id).toBe('b');
    expect(selectEffectiveRule(next, 'agent-A')?.id).toBe('a');
  });

  it('replacing a grant for the same agent deactivates the prior one', () => {
    const old = makeRule({ id: 'old', agentId: 'agent-A', preset: 'readOnly' });
    const fresh = makeRule({ id: 'new', agentId: 'agent-A', preset: 'fullAccess' });
    const next = applyDelegationUpdate([old], fresh);

    expect(next.find((r) => r.id === 'old')?.isActive).toBe(false);
    expect(selectEffectiveRule(next, 'agent-A')?.id).toBe('new');
  });

  it('a new session-wide rule replaces the old session-wide rule, not per-agent rules', () => {
    const sessionOld = makeRule({ id: 's-old', agentId: null });
    const perAgent = makeRule({ id: 'a', agentId: 'agent-A' });
    const sessionNew = makeRule({ id: 's-new', agentId: null });
    const next = applyDelegationUpdate([sessionOld, perAgent], sessionNew);

    expect(next.find((r) => r.id === 's-old')?.isActive).toBe(false);
    expect(next.find((r) => r.id === 'a')?.isActive).toBe(true);
    expect(next.find((r) => r.id === 's-new')?.isActive).toBe(true);
  });

  it('updates a rule in place by id (revoke path)', () => {
    const rule = makeRule({ id: 'a', agentId: 'agent-A', isActive: true });
    const revoked = { ...rule, isActive: false };
    const next = applyDelegationUpdate([rule], revoked);
    expect(next.filter((r) => r.id === 'a')).toHaveLength(1);
    expect(next.find((r) => r.id === 'a')?.isActive).toBe(false);
  });

  it('does not mutate the input array or its rules', () => {
    const ruleA = makeRule({ id: 'a', agentId: 'agent-A' });
    const input = [ruleA];
    applyDelegationUpdate(input, makeRule({ id: 'a2', agentId: 'agent-A' }));
    expect(input).toHaveLength(1);
    expect(ruleA.isActive).toBe(true);
  });
});

describe('ruleScopeKey', () => {
  it('keys per-agent rules by agent id and session-wide rules together', () => {
    expect(ruleScopeKey({ agentId: 'agent-A' })).toBe('agent-A');
    expect(ruleScopeKey({ agentId: null })).toBe(ruleScopeKey({ agentId: null }));
    expect(ruleScopeKey({ agentId: 'agent-A' })).not.toBe(ruleScopeKey({ agentId: 'agent-B' }));
  });
});
