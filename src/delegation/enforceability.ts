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
 *    Chrome reports starting in the agent's tab, on a debugger session ABG
 *    holds there, is cancelled for every agent type (see `downloadsEnforced`
 *    below). (This is an
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
 * `originUrl` is the page the agent was detected on.
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
  /**
   * What Browser-layer blocking is doing in the agent's tab, to render on its
   * card: why Chrome's debugging banner is showing, or that the layer fell back
   * (ADR-007 "Browser-layer enforcement unavailable" notice). Null when the
   * layer does not apply to the tab.
   */
  browserLayerNote: BrowserLayerNote | null;
}

/** Pill text for an external driver whose downloads the delegation cancels. */
export const EXTERNAL_DRIVER_DOWNLOADS_ENFORCED_LABEL = 'Partly enforced';

/**
 * What Browser-layer blocking is doing in a tab it applies to (setting on, an
 * agent detected there, a delegation that blocks a site or withholds
 * downloads): holding its debugger session, or holding none because Chrome
 * refused or ended it.
 */
export type BrowserLayerState =
  | { state: 'attached' }
  | {
      state: 'unavailable';
      /** Chrome refused the session, or ended one that was held. */
      cause: 'attach-failed' | 'detached';
      /** Chrome's error text or detach reason, when it gave one. */
      detail?: string;
    };

/** Card text for a {@link BrowserLayerState}. */
export interface BrowserLayerNote {
  /** `active`: the session is held. `unavailable`: enforcement fell back. */
  kind: 'active' | 'unavailable';
  text: string;
}

/** What the background worker reports about the agent's tab. */
export interface AgentTabState {
  /**
   * The agent's tab holds ABG's debugger session (Browser-layer blocking),
   * which reports the downloads started there. Without it no download is tied
   * to the agent's tab, so none is cancelled.
   */
  downloadsWatched?: boolean;
  /** Set only for a tab Browser-layer blocking applies to. */
  browserLayer?: BrowserLayerState;
}

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
 * Whether downloads started in this agent's tab are cancelled under `rule`: a
 * rule is set, it blocks `download-file`, and the agent's tab holds ABG's
 * debugger session, the only thing that ties a download to a tab. A download
 * that merely shares the agent page's host is never cancelled. The ONE
 * predicate that picks both the pill and the caveat variant, so they can never
 * disagree.
 */
export function downloadsEnforced(
  _agent: AgentLike,
  rule: DelegationRule | null,
  tab: AgentTabState = {},
): boolean {
  return (
    rule !== null &&
    tab.downloadsWatched === true &&
    rule.scope.actionRestrictions.some((r) => r.capability === 'download-file' && r.action === 'block')
  );
}

/** Why Chrome ended a session it reports with `reason`, as a clause; '' when not one we know. */
function detachReasonClause(reason: string | undefined): string {
  if (reason === 'canceled_by_user') return ' when its debugging banner was cancelled';
  if (reason === 'target_closed') return ' when the page it was attached to closed';
  return '';
}

/** `text` as a sentence: ends with a full stop unless it already ends one. */
function asSentence(text: string): string {
  return /[.!?]$/.test(text) ? text : `${text}.`;
}

/**
 * What the session is attached for, as the clause after "attached to this
 * tab": the sites the rule blocks, the downloads it cancels there, both, or ''
 * when neither holds (downloads the rule blocks are not cancelled in a tab
 * whose downloads are not tied to it, so nothing is claimed for them).
 */
function attachedPurposeClause(blocksSites: boolean, cancelsDownloads: boolean): string {
  if (blocksSites && cancelsDownloads) {
    return ' to enforce the sites your delegation blocks and to cancel downloads started in it';
  }
  if (blocksSites) return ' to enforce the sites your delegation blocks';
  if (cancelsDownloads) return ' to cancel downloads started in it';
  return '';
}

/**
 * What is not done on the tab while the session is missing, as a sentence
 * with a leading space, or '' when the rule neither blocks a site nor blocks
 * downloads.
 */
function notEnforcedSentence(blocksSites: boolean, blocksDownloads: boolean): string {
  if (blocksSites) {
    return ` Until it attaches, the sites your delegation blocks are not enforced at the browser layer on this tab${blocksDownloads ? ', and downloads started in it are not cancelled' : ''}.`;
  }
  if (blocksDownloads) return ' Until it attaches, downloads started in this tab are not cancelled.';
  return '';
}

/**
 * What the page level still does while the session is missing, as a sentence
 * with a leading space. Claimed only for an agent it applies to (it does not
 * stop an external driver), and never for downloads: nothing at the page
 * level cancels one.
 */
function pageLevelSentence(agent: AgentLike, blocksSites: boolean): string {
  if (isExternalDriver(agent)) {
    return ` Page-level policy does not stop this agent${blocksSites ? ', so those sites are not blocked for it here' : ''}.`;
  }
  return blocksSites
    ? ' Page-level enforcement still applies on a best-effort basis.'
    : " Page-level enforcement of the agent's other actions still applies on a best-effort basis.";
}

/**
 * The card text for what Browser-layer blocking is doing in the agent's tab.
 *
 * A session is held for a rule that blocks a site, a rule that blocks
 * downloads, or both, so the text names only what the rule in force has it
 * do: a Read-Only session with no blocked site is there for downloads alone.
 *
 * Attached: says what the session is for, that it is why Chrome shows its
 * debugging banner, and when it goes. Unavailable: says the layer fell back,
 * quotes Chrome's own reason instead of guessing at one, names what is not
 * enforced meanwhile, and claims the page-level fallback only for an agent it
 * applies to (it does not stop an external driver). Null without a rule: the
 * layer acts on a delegation, so with none there is nothing to say.
 */
export function browserLayerNote(
  agent: AgentLike,
  rule: DelegationRule | null,
  tab: AgentTabState = {},
): BrowserLayerNote | null {
  const state = tab.browserLayer;
  if (!rule || !state) return null;
  const blocksSites = rule.scope.sitePatterns.some((p) => p.action === 'block');
  if (state.state === 'attached') {
    const purpose = attachedPurposeClause(blocksSites, downloadsEnforced(agent, rule, tab));
    return {
      kind: 'active',
      text: `Browser-layer blocking is attached to this tab${purpose}. That is why Chrome shows its "debugging this browser" banner. It detaches when the delegation or the agent's session ends, the tab closes, or the setting is turned off.`,
    };
  }
  if (state.state !== 'unavailable') return null;
  const what =
    state.cause === 'detached'
      ? `Chrome ended Browser-layer blocking's debugger session on this tab${detachReasonClause(state.detail)}.`
      : `Browser-layer blocking could not attach to this tab.${state.detail ? ` Chrome reported: ${asSentence(state.detail)}` : ''}`;
  const blocksDownloads = rule.scope.actionRestrictions.some(
    (r) => r.capability === 'download-file' && r.action === 'block',
  );
  const lost = notEnforcedSentence(blocksSites, blocksDownloads);
  const fallback = lost ? pageLevelSentence(agent, blocksSites) : '';
  return {
    kind: 'unavailable',
    text: `${what}${lost}${fallback} AI Browser Guard retries automatically.`,
  };
}

/**
 * Decide what to show for a detected agent. This replaces the inline popup logic
 * that showed "Managed" whenever a rule existed — which asserted governance ABG
 * cannot deliver against an external driver.
 */
export function presentAgent(
  agent: AgentLike,
  rule: DelegationRule | null,
  tab: AgentTabState = {},
): AgentPresentation {
  const layerNote = browserLayerNote(agent, rule, tab);
  if (isExternalDriver(agent)) {
    const enforcedDownloads = downloadsEnforced(agent, rule, tab);
    const host = hostOf(agent.originUrl);
    let ruleCaveat: string | null = null;
    if (rule) {
      ruleCaveat = enforcedDownloads
        ? `Page-level policy does not stop this agent: it drives the browser directly. Under this delegation, downloads started in this agent's tab${host ? ` (detected on ${host})` : ''} are cancelled, yours included. The kill switch (close tab) is the hard stop.`
        : 'Page-level policy does not stop this agent: it drives the browser directly. The kill switch (close tab) is the hard stop.';
    }
    return {
      enforceable: false,
      badge: enforcedDownloads ? EXTERNAL_DRIVER_DOWNLOADS_ENFORCED_LABEL : 'Monitor only',
      badgeTitle:
        'This agent drives the browser directly (CDP/WebDriver). AI Browser Guard can detect and alert on it, but cannot block the actions it takes in the page. Use the kill switch to close the tab it controls.',
      ruleCaveat,
      browserLayerNote: layerNote,
    };
  }
  return {
    enforceable: true,
    badge: rule ? 'Managed (best-effort)' : 'Detected',
    badgeTitle: rule
      ? 'In-page automation under an active policy. Page-level enforcement applies on a best-effort basis.'
      : 'In-page automation detected.',
    ruleCaveat: null,
    browserLayerNote: layerNote,
  };
}
