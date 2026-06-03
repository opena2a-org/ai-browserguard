/**
 * Capability boundary monitor.
 *
 * Tracks what an agent does vs. what it is allowed to do under the
 * active delegation rules.
 */

import type { AgentCapability } from '../types/agent';
import type { AgentEvent, BoundaryViolation } from '../types/events';
import type { DelegationRule } from '../types/delegation';
import { evaluateRule, isTimeBoundExpired } from '../delegation/rules';
import { createTimelineEvent } from '../session/timeline';
import { matchUrlPattern } from '../url/match-pattern';

export interface MonitorState {
  activeRule: DelegationRule | null;
  isMonitoring: boolean;
  allowedCount: number;
  blockedCount: number;
  recentViolations: BoundaryViolation[];
}

export interface BoundaryCheckResult {
  allowed: boolean;
  matchedRule: DelegationRule | null;
  reason: string;
  matchDetail?: string;
}

let monitorState: MonitorState = {
  activeRule: null,
  isMonitoring: false,
  allowedCount: 0,
  blockedCount: 0,
  recentViolations: [],
};

/**
 * Check whether an agent action is permitted under delegation rules.
 *
 * Pass-through when no rule exists: normal browsing is never blocked.
 * Fail-closed when a rule IS active: actions not explicitly permitted are blocked.
 */
export function checkBoundary(
  action: AgentCapability,
  url: string,
  rule: DelegationRule | null
): BoundaryCheckResult {
  // No rule → pass-through (normal browsing without agent delegation)
  if (!rule) {
    return {
      allowed: true,
      matchedRule: null,
      reason: 'No active delegation rule — pass-through.',
    };
  }

  if (!rule.isActive) {
    return {
      allowed: true,
      matchedRule: rule,
      reason: 'Delegation rule is inactive — pass-through.',
    };
  }

  if (isDelegationExpired(rule)) {
    return {
      allowed: false,
      matchedRule: rule,
      reason: 'Delegation has expired.',
    };
  }

  const result = evaluateRule(rule, action, url);
  return {
    allowed: result.allowed,
    matchedRule: rule,
    reason: result.reason,
  };
}

/**
 * Match a URL against a site pattern using glob-style matching.
 *
 * Delegates to the shared hardened matcher so the monitor, the interceptor, and
 * delegation-rule evaluation agree exactly (ReDoS guard + literal `?`).
 */
export function matchSitePattern(url: string, pattern: string): boolean {
  return matchUrlPattern(url, pattern);
}

function mapEventToCapability(eventType: string): AgentCapability | null {
  switch (eventType) {
    case 'click': return 'click';
    case 'input': return 'type-text';
    case 'submit': return 'submit-form';
    case 'keydown': return 'type-text';
    default: return null;
  }
}

function getSelector(el: Element): string {
  if (!el || !el.tagName) return 'unknown';
  if (el.id) return `#${el.id}`;
  if (el.className && typeof el.className === 'string') {
    const classes = el.className.trim().split(/\s+/).slice(0, 2).join('.');
    if (classes) return `${el.tagName.toLowerCase()}.${classes}`;
  }
  return el.tagName.toLowerCase();
}

/**
 * Start monitoring agent actions in the current page.
 */
/**
 * User gesture grace period (ms).
 *
 * Web apps like Gmail dispatch synthetic events internally in response to
 * user clicks (e.g. for routing, focus management, delegated handlers).
 * These synthetic events fire within milliseconds of the real user action
 * and should NOT be treated as agent activity.
 *
 * When a trusted user event occurs, we suppress monitoring for this window
 * so that page-internal synthetic events pass through. Agent-initiated
 * synthetic events are independent of user gestures and will fire outside
 * this grace window.
 */
const USER_GESTURE_GRACE_MS = 150;

export function startBoundaryMonitor(
  rule: DelegationRule | null,
  onViolation: (violation: BoundaryViolation) => void,
  onAction: (event: AgentEvent) => void
): () => void {
  monitorState = {
    activeRule: rule,
    isMonitoring: true,
    allowedCount: 0,
    blockedCount: 0,
    recentViolations: [],
  };

  const cleanups: Array<() => void> = [];

  // Track the timestamp of the last trusted user event so we can distinguish
  // page-internal synthetic events (triggered by user) from agent-dispatched ones.
  let lastTrustedEventAt = 0;

  const trustedEventTracker = (e: Event) => {
    if (e.isTrusted) {
      lastTrustedEventAt = Date.now();
    }
  };

  // Track trusted events on the same event types we monitor
  const eventTypes = ['click', 'input', 'submit', 'keydown'];
  for (const type of eventTypes) {
    document.addEventListener(type, trustedEventTracker, { capture: true });
  }
  cleanups.push(() => {
    for (const type of eventTypes) {
      document.removeEventListener(type, trustedEventTracker, { capture: true });
    }
  });

  // Intercept user interaction events
  const interceptionHandler = (e: Event) => {
    if (!monitorState.isMonitoring) return;
    if (e.isTrusted) return; // Only intercept synthetic/untrusted events from agents

    // Grace period: if a trusted user event happened recently, this synthetic
    // event is likely page-internal (e.g. Gmail re-dispatching for routing)
    // rather than agent-initiated. Pass it through.
    if (Date.now() - lastTrustedEventAt < USER_GESTURE_GRACE_MS) return;

    const capability = mapEventToCapability(e.type);
    if (!capability) return;

    const target = e.target as Element;
    const selector = target ? getSelector(target) : undefined;
    const url = window.location.href;

    const result = checkBoundary(capability, url, monitorState.activeRule);

    if (result.allowed) {
      monitorState.allowedCount++;
      const event = createTimelineEvent('action-allowed', url, `${capability} allowed`, {
        targetSelector: selector,
        attemptedAction: capability,
        outcome: 'allowed',
        ruleId: monitorState.activeRule?.id,
      });
      onAction(event);
    } else {
      monitorState.blockedCount++;
      e.preventDefault();
      // stopImmediatePropagation (not stopPropagation): we run in the capture
      // phase on `document`, and stopPropagation alone still lets the page's own
      // listeners on the SAME node at the SAME phase run — a blocked agent action
      // would reach the page's submit/click handlers anyway. stopImmediatePropagation
      // also halts the remaining same-node listeners, so the action is truly blocked.
      e.stopImmediatePropagation();

      const violation: BoundaryViolation = {
        id: crypto.randomUUID(),
        timestamp: new Date().toISOString(),
        agentId: '',
        attemptedAction: capability,
        url,
        targetSelector: selector,
        blockingRuleId: monitorState.activeRule?.id ?? 'none',
        reason: result.reason,
        userOverride: false,
      };
      monitorState.recentViolations.push(violation);
      if (monitorState.recentViolations.length > 50) {
        monitorState.recentViolations.shift();
      }
      onViolation(violation);

      const event = createTimelineEvent('action-blocked', url, `${capability} blocked: ${result.reason}`, {
        targetSelector: selector,
        attemptedAction: capability,
        outcome: 'blocked',
        ruleId: monitorState.activeRule?.id,
      });
      onAction(event);
    }
  };

  for (const type of eventTypes) {
    document.addEventListener(type, interceptionHandler, { capture: true });
  }
  cleanups.push(() => {
    for (const type of eventTypes) {
      document.removeEventListener(type, interceptionHandler, { capture: true });
    }
  });

  return () => {
    monitorState.isMonitoring = false;
    for (const cleanup of cleanups) {
      try { cleanup(); } catch { /* ignore */ }
    }
  };
}

/**
 * Update the active delegation rule.
 */
export function updateActiveRule(rule: DelegationRule | null): void {
  monitorState.activeRule = rule;
}

/**
 * Check if the current delegation has expired.
 */
export function isDelegationExpired(rule: DelegationRule): boolean {
  return isTimeBoundExpired(rule.scope.timeBound);
}

/**
 * Get the current monitor state.
 */
export function getMonitorState(): MonitorState {
  return { ...monitorState };
}
