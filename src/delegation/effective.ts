/**
 * Per-agent delegation resolution.
 *
 * Delegation rules are bound to a specific detected agent (`agentId`) or are
 * session-wide (`agentId === null`). Enforcement happens per tab, and a tab is
 * driven by at most one detected agent, so "which rule governs this tab" is
 * "which rule governs this tab's agent". These pure helpers encode that
 * resolution and the replace-only-same-scope update so that allowing one agent
 * never grants access to another.
 */

import type { DelegationRule } from '../types/delegation';
import { isTimeBoundExpired } from './rules';

/**
 * Scope key deciding which prior rules a new grant replaces. Per-agent rules
 * key off the agent id; every session-wide rule shares one key.
 */
export function ruleScopeKey(rule: Pick<DelegationRule, 'agentId'>): string {
  return rule.agentId ?? '__session__';
}

/**
 * Resolve the rule in effect for the agent currently active in a tab.
 *
 * A non-expired, active rule bound to `agentId` wins; otherwise an active
 * session-wide rule applies; otherwise there is none (pass-through). Pass
 * `null` for `agentId` when no agent is detected in the tab.
 */
export function selectEffectiveRule(
  rules: DelegationRule[],
  agentId: string | null,
): DelegationRule | null {
  const active = rules.filter((r) => r.isActive && !isTimeBoundExpired(r.scope.timeBound));
  if (agentId !== null) {
    const perAgent = active.find((r) => r.agentId === agentId);
    if (perAgent) return perAgent;
  }
  return active.find((r) => r.agentId === null) ?? null;
}

/**
 * Apply an incoming delegation rule to the rule set: add or replace it by id,
 * then deactivate only prior rules in the SAME scope (same agent, or the single
 * session-wide slot). Rules for other agents are returned untouched.
 *
 * Returns a new array; does not mutate the input or its elements.
 */
export function applyDelegationUpdate(
  rules: DelegationRule[],
  incoming: DelegationRule,
): DelegationRule[] {
  const incomingScope = ruleScopeKey(incoming);
  const withoutIncoming = rules.filter((r) => r.id !== incoming.id);
  const next = withoutIncoming.map((r) =>
    ruleScopeKey(r) === incomingScope && r.isActive ? { ...r, isActive: false } : r,
  );
  next.push(incoming);
  return next;
}
