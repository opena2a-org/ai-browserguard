/**
 * Enforceability decision (ADR-007 / ADR-008).
 *
 * ONE source of truth for the question every user-facing surface must answer
 * accurately: "can AI Browser Guard enforce action policy on THIS detected
 * agent, and what do we tell the user?"
 *
 * Ground truth (see docs/adr/007 and 008, and the enforcement audit):
 *  - An EXTERNAL driver (Playwright/Puppeteer/Selenium/Computer-Use/Operator/raw
 *    CDP/WebDriver) owns the tab's sole debugger slot and acts via NATIVE input
 *    (`Input.dispatchMouseEvent`/`insertText`), which the browser marks
 *    `isTrusted:true`. The MAIN-world interceptor only wraps page-JS globals and
 *    only reacts to untrusted/synthetic events, and `chrome.debugger.attach`
 *    fails against a slot we don't own. So per-action enforcement is
 *    IMPOSSIBLE for this population — ABG can detect + alert + kill the tab, not
 *    block individual actions.
 *  - An IN-PAGE / injected / page-JS agent has no external CDP session; its
 *    scripted actions run through the wrapped globals, so page-realm enforcement
 *    genuinely applies (best-effort — a hostile page can still re-patch, audit #32).
 *
 * This module is pure and dependency-free so it can be unit-tested and reused by
 * the popup, the session report, and the content toast without duplicating (and
 * drifting) the enforceability logic.
 */

import type { AgentIdentity, AgentType, DetectionMethod } from '../types/agent';
import type { DelegationRule } from '../types/delegation';

/** Agent types that are, by definition, external drivers we cannot enforce against. */
const EXTERNAL_DRIVER_TYPES: ReadonlySet<AgentType> = new Set<AgentType>([
  'playwright',
  'puppeteer',
  'selenium',
  'anthropic-computer-use',
  'openai-operator',
  'cdp-generic',
  'webdriver-generic',
]);

/**
 * Detection methods that place the agent in the PAGE REALM — where the
 * interceptor and monitor can see and act on it:
 *  - `synthetic-event` — an untrusted DOM event the monitor observes directly.
 *  - `framework-fingerprint` — a page-JS `Runtime.evaluate` call stack, i.e. the
 *    agent is executing through page JavaScript.
 * Every OTHER signal is NOT page-realm: `cdp-connection` / `webdriver-flag` /
 * `automation-flag` are external-driver signals, and the behavioural methods
 * (`behavioral-timing` / `-precision` / `-typing`) are inferred from NATIVE
 * input, which is not observable. Those all fail safe to "external".
 */
const PAGE_REALM_METHODS: ReadonlySet<DetectionMethod> = new Set<DetectionMethod>([
  'synthetic-event',
  'framework-fingerprint',
]);

/** Minimal shape this module needs — accepts a full AgentIdentity or a stub. */
export type AgentLike = Pick<AgentIdentity, 'type' | 'detectionMethods'>;

/**
 * True when ABG cannot see or enforce against the agent's actions from the page
 * realm — an external CDP/WebDriver driver (or an agent we can only infer from
 * native-input behaviour).
 *
 * Fails safe toward "external" (not observable / not enforceable): a known
 * external type is external, and an agent of unknown type is treated as
 * page-realm ONLY when it carries positive page-realm evidence and nothing else
 * (every detection method is in `PAGE_REALM_METHODS`). No signal at all, any
 * external-driver signal, or any native-input behavioural signal → external.
 * This is the conservative direction for a security tool: we never claim
 * observability/enforcement we cannot deliver.
 */
export function isExternalDriver(agent: AgentLike): boolean {
  if (EXTERNAL_DRIVER_TYPES.has(agent.type)) return true;
  const methods = agent.detectionMethods;
  if (methods.length === 0) return true;
  return !methods.every((m) => PAGE_REALM_METHODS.has(m));
}

export type EnforcementReality =
  /** External driver: detection + alert + kill-tab only; no per-action enforcement. */
  | 'none'
  /** In-page/injected agent: page-realm interception applies (best-effort). */
  | 'page-realm-best-effort';

export function enforcementReality(agent: AgentLike): EnforcementReality {
  return isExternalDriver(agent) ? 'none' : 'page-realm-best-effort';
}

/**
 * Whether ABG can OBSERVE this agent's individual actions in the session
 * report/timeline. False for external drivers — their native CDP input is not
 * observable, so a `0 actions` count for them means "unseen", not "nothing
 * happened". The report must say so.
 */
export function nativeInputObservable(agent: AgentLike): boolean {
  return !isExternalDriver(agent);
}

/** Canonical, reused disclosure string for unobservable external drivers. */
export const UNOBSERVABLE_SCOPE_NOTE =
  'Counts cover page-level actions AI Browser Guard can see. This agent drives the browser directly (CDP/WebDriver); its clicks, typing, and screenshots are not observable and are not included here.';

/** Ready-to-render presentation for a detected agent and its rule (if any). */
export interface AgentPresentation {
  /** Can ABG enforce action policy on this agent at all? */
  enforceable: boolean;
  /** Trust-pill text. Never "Managed" for an agent we cannot manage. */
  badge: string;
  /** Trust-pill tooltip — states the true capability plainly. */
  badgeTitle: string;
  /**
   * When a delegation rule is set on an unenforceable agent, the scope caveat to
   * render next to the grant so "Read-Only" is not read as an enforced boundary.
   * Null when the grant is (best-effort) enforceable or no rule is set.
   */
  ruleCaveat: string | null;
}

/**
 * Decide what to show for a detected agent. This replaces the inline popup logic
 * that showed "Managed" whenever a rule existed — which asserted governance ABG
 * cannot deliver against an external driver.
 */
export function presentAgent(agent: AgentLike, rule: DelegationRule | null): AgentPresentation {
  if (isExternalDriver(agent)) {
    return {
      enforceable: false,
      badge: 'Monitor only',
      badgeTitle:
        'This agent drives the browser directly (CDP/WebDriver). AI Browser Guard can detect and alert on it, but cannot block its individual actions. Use the kill switch to close the tab it controls.',
      ruleCaveat: rule
        ? 'Not enforced. This agent bypasses page-level policy — the kill switch (close tab) is the hard stop.'
        : null,
    };
  }
  return {
    enforceable: true,
    badge: rule ? 'Managed (best-effort)' : 'Detected',
    badgeTitle: rule
      ? 'In-page automation under an active policy. Page-level enforcement applies on a best-effort basis.'
      : 'In-page automation detected.',
    ruleCaveat: null,
  };
}
