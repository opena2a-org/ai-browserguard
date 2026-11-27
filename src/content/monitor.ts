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
};

/**
 * One-shot "Allow once" overrides for MONITOR-path blocks (F-B).
 *
 * The block toast's "Allow once" used to grant only into the MAIN-world
 * interceptor's set — but the commonest in-page block (a synthetic click/type
 * under a Read-Only rule) is issued by THIS monitor in the ISOLATED world,
 * which never consulted any override. The button was inert exactly where users
 * saw it most. Keys are `${capability}:${url}`, mirroring the MAIN-world set;
 * an entry is consumed by the first matching event.
 */
const monitorAllowedOnce: Set<string> = new Set();

/** Grant a one-shot override for the next monitor-blocked (capability, url). */
export function grantMonitorAllowOnce(capability: string, url: string): void {
  monitorAllowedOnce.add(`${capability}:${url}`);
}

/**
 * Purge all pending overrides. Called on kill-switch activation — mirroring
 * the MAIN-world interceptor, which clears its own allow-once set when the
 * sentinel arms: overrides granted before the emergency were granted under
 * conditions the emergency invalidates, and a stale grant must not let an
 * action through a monitor that is later re-armed while the switch is active.
 */
export function clearMonitorAllowOnce(): void {
  monitorAllowedOnce.clear();
}

/** Consume (and report) a pending one-shot override for this capability+url. */
function consumeMonitorAllowOnce(capability: string, url: string): boolean {
  const key = `${capability}:${url}`;
  if (monitorAllowedOnce.has(key)) {
    monitorAllowedOnce.delete(key);
    return true;
  }
  return false;
}

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

/**
 * Submit held after a denied text input (#70).
 *
 * An agent that types or pastes into a form or editor and then presses Enter,
 * Cmd/Ctrl+Return or clicks the submit button sends whatever the field holds
 * when its input was denied: an empty or half-written message, a search for
 * the wrong term. After the monitor blocks an untrusted text input, it holds
 * the untrusted submits that follow in the same sequence and says why, so the
 * agent's next step does not act on text that never reached the page.
 *
 * The sequence ends when a text input is let through, on a trusted user event,
 * when the delegation rule changes, or DENIED_INPUT_SEQUENCE_MS after the last
 * denied input.
 */
export const DENIED_INPUT_SEQUENCE_MS = 10_000;

export const HELD_SUBMIT_REASON =
  'Held: the text input just before it was blocked, so it did not reach the page.';

/** When the last untrusted text input was denied; 0 when no sequence is open. */
let deniedInputAt = 0;

function deniedInputPending(): boolean {
  if (deniedInputAt === 0) return false;
  if (Date.now() - deniedInputAt > DENIED_INPUT_SEQUENCE_MS) {
    deniedInputAt = 0;
    return false;
  }
  return true;
}

/** An untrusted `input` event, or a keydown that types or deletes text. */
function isTextInput(e: Event): boolean {
  if (e.type === 'input') return true;
  if (e.type !== 'keydown') return false;
  const key = (e as KeyboardEvent).key;
  return typeof key === 'string' && (key.length === 1 || key === 'Backspace' || key === 'Delete');
}

/** A submit control: a form's submit button, or a button outside any form. */
function isSubmitControl(target: EventTarget | null): boolean {
  if (!target || typeof (target as Element).closest !== 'function') return false;
  const control = (target as Element).closest('button, input, [role="button"]');
  if (!control) return false;
  if (control instanceof HTMLInputElement) {
    return (control.type === 'submit' || control.type === 'image') && control.form !== null;
  }
  if (control instanceof HTMLButtonElement) {
    return control.form === null || control.type === 'submit';
  }
  return control.closest('form') === null;
}

/**
 * Whether an untrusted event submits what was typed: a `submit` event, Enter or
 * Cmd/Ctrl+Return (Shift+Enter and Alt+Enter add a line instead), or a click on
 * a submit control.
 */
function isSubmitAction(e: Event): boolean {
  if (e.type === 'submit') return true;
  if (e.type === 'keydown') {
    const k = e as KeyboardEvent;
    return k.key === 'Enter' && !k.shiftKey && !k.altKey;
  }
  if (e.type === 'click') return isSubmitControl(e.target);
  return false;
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
  };
  deniedInputAt = 0;

  const cleanups: Array<() => void> = [];

  // Track the timestamp of the last trusted user event so we can distinguish
  // page-internal synthetic events (triggered by user) from agent-dispatched ones.
  let lastTrustedEventAt = 0;

  const trustedEventTracker = (e: Event) => {
    if (e.isTrusted) {
      lastTrustedEventAt = Date.now();
      // The user is acting: what follows is not the agent's sequence.
      deniedInputAt = 0;
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

    // "Allow once" (F-B): a pending one-shot override lets exactly one
    // otherwise-blocked event through, consumed on use. Checked before the
    // boundary evaluation so the override applies to precisely the (capability,
    // url) the user approved from the toast/notification.
    if (consumeMonitorAllowOnce(capability, url)) {
      monitorState.allowedCount++;
      const event = createTimelineEvent('action-allowed', url, `${capability} allowed (one-time override)`, {
        targetSelector: selector,
        attemptedAction: capability,
        outcome: 'allowed',
        ruleId: monitorState.activeRule?.id,
      });
      onAction(event);
      if (isTextInput(e)) deniedInputAt = 0;
      return;
    }

    // A submit that follows a denied text input in the same sequence is held
    // whatever the rule says about submitting, and the reason says the input
    // did not land (#70).
    const held = deniedInputPending() && isSubmitAction(e);
    const result: BoundaryCheckResult = held
      ? { allowed: false, matchedRule: monitorState.activeRule, reason: HELD_SUBMIT_REASON }
      : checkBoundary(capability, url, monitorState.activeRule);

    if (result.allowed) {
      if (isTextInput(e)) deniedInputAt = 0;
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
      if (!held && isTextInput(e)) deniedInputAt = Date.now();

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
  deniedInputAt = 0;
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
