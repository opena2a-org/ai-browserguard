/**
 * Enforceability decision (ADR-007 / ADR-008).
 *
 * ONE source of truth for the question every user-facing surface must answer
 * accurately: "can AI Browser Guard enforce action policy on THIS detected
 * agent, and what do we tell the user?"
 *
 * Ground truth (see docs/adr/007 and 008, and the enforcement audit):
 *  - An EXTERNAL driver (Playwright/Puppeteer/Selenium/Computer-Use/Operator/raw
 *    CDP/WebDriver) acts via NATIVE input (`Input.dispatchMouseEvent`/
 *    `insertText`), which the browser marks `isTrusted:true`. The MAIN-world
 *    interceptor only wraps page-JS globals and only reacts to untrusted/
 *    synthetic events, so it never sees these actions — and no attribution
 *    signal exists that could tell the driver's native input from the human's.
 *    So per-ACTION enforcement of page actions is IMPOSSIBLE for this
 *    population — ABG can detect + alert + kill the tab, not block the actions
 *    it takes in the page. Downloads are the exception: they are cancelled by
 *    the service worker through `chrome.downloads`, which needs no input
 *    attribution, so under a delegation that blocks `download-file` a download
 *    from the host the agent was detected on is cancelled for every agent type
 *    (see `downloadsEnforced` below). (This is an
 *    attribution limit, not a debugger-slot limit: on current multi-client
 *    Chrome our `chrome.debugger.attach` typically SUCCEEDS alongside an
 *    external driver, which is why the tab-wide blocked-domain egress layer
 *    (ADR-007) can still mediate network on such tabs — it needs no
 *    attribution. It does not change the per-action verdict here.)
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

/**
 * Minimal shape this module needs — accepts a full AgentIdentity or a stub.
 * `originUrl` is the page the agent was detected on; without it (or when it
 * has no host name) no download is tied to the agent.
 */
export type AgentLike = Pick<AgentIdentity, 'type' | 'detectionMethods'> &
  Partial<Pick<AgentIdentity, 'originUrl'>>;

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
  /**
   * External driver: detection + alert + kill-tab only; no enforcement of the
   * actions it takes in the page. Downloads are handled outside the page and
   * are not covered by this value (see `presentAgent`).
   */
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
  /**
   * Can ABG enforce page-action policy on this agent? False for external
   * drivers even when their downloads are cancelled, because page actions are
   * still not enforced (ADR-008).
   */
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

/** Pill text for an external driver whose downloads the delegation cancels. */
export const EXTERNAL_DRIVER_DOWNLOADS_ENFORCED_LABEL = 'Partly enforced';

/** The hostname of `url`, or '' when it is missing, unparseable or host-less. */
function hostOf(url: string | undefined): string {
  if (!url) return '';
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

/**
 * Whether downloads tied to this agent are cancelled under `rule`: a rule is
 * set, the agent's origin has a host name for a download to match, and the
 * rule blocks `download-file`. The ONE predicate that picks both the pill and
 * the caveat variant, so they can never disagree.
 */
export function downloadsEnforced(agent: AgentLike, rule: DelegationRule | null): boolean {
  return (
    rule !== null &&
    hostOf(agent.originUrl) !== '' &&
    rule.scope.actionRestrictions.some((r) => r.capability === 'download-file' && r.action === 'block')
  );
}

/**
 * Decide what to show for a detected agent. This replaces the inline popup logic
 * that showed "Managed" whenever a rule existed — which asserted governance ABG
 * cannot deliver against an external driver.
 */
export function presentAgent(agent: AgentLike, rule: DelegationRule | null): AgentPresentation {
  if (isExternalDriver(agent)) {
    const enforcedDownloads = downloadsEnforced(agent, rule);
    let ruleCaveat: string | null = null;
    if (rule) {
      ruleCaveat = enforcedDownloads
        ? `Page-level policy does not stop this agent: it drives the browser directly. Under this delegation, downloads from ${hostOf(agent.originUrl)} are cancelled, yours included. The kill switch (close tab) is the hard stop.`
        : 'Page-level policy does not stop this agent: it drives the browser directly. The kill switch (close tab) is the hard stop.';
    }
    return {
      enforceable: false,
      badge: enforcedDownloads ? EXTERNAL_DRIVER_DOWNLOADS_ENFORCED_LABEL : 'Monitor only',
      badgeTitle:
        'This agent drives the browser directly (CDP/WebDriver). AI Browser Guard can detect and alert on it, but cannot block the actions it takes in the page. Use the kill switch to close the tab it controls.',
      ruleCaveat,
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
