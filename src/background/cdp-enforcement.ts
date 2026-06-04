/**
 * CDP-layer network egress enforcement (ADR-007).
 *
 * Moves network-egress enforcement off the page realm onto the
 * `chrome.debugger` (CDP) `Fetch` domain, which a hostile first-party page
 * cannot re-patch (audit #32). The page-realm interceptor remains the default
 * and the fail-safe fallback; this layer is opt-in
 * (`settings.cdpEnforcementEnabled`) and attaches only while a tab is under an
 * active delegation to a detected agent.
 *
 * Scope boundary: a tab admits one debugger client at a time. This layer
 * therefore enforces against in-page / injected agents (the actors that defeat
 * MAIN-world enforcement by re-patching globals); it does NOT stop an external
 * CDP framework (Playwright/Puppeteer) that already owns the tab's debugger
 * slot — `attach()` simply fails there, and we fail safe to the page-realm
 * interceptor. Detection plus the ISOLATED-world gates remain the defense for
 * that population.
 *
 * Must run in the background service worker — `chrome.debugger` is not
 * available in content scripts.
 */

import type { DelegationRule } from '../types/delegation';
import { isTimeBoundExpired } from '../delegation/rules';
import { matchUrlPattern } from '../url/match-pattern';

/** Remote debugging protocol version requested on attach. */
export const CDP_PROTOCOL_VERSION = '1.3';

/** Decision for a single intercepted request. */
export interface FetchDecision {
  block: boolean;
  reason: string;
}

/**
 * Decide whether a single network request should be blocked at the CDP layer.
 *
 * IMPORTANT — why this is NOT the full page-realm `network-request` decision:
 * the CDP `Fetch` domain pauses EVERY request on the tab and carries no
 * agent-vs-user attribution (that signal exists only in the page realm via
 * call-stack heuristics). So the CDP layer cannot honor the `network-request`
 * *capability* withhold — doing so would fail the page's own resources and the
 * human's navigation, bricking the tab. The capability-level block stays in the
 * page realm (best-effort, but attributed).
 *
 * What the CDP layer CAN enforce repatch-immune is an explicit site `block`
 * pattern: a coarse, tab-wide domain block the user deliberately set. That is
 * blocked here regardless of how the request was initiated (and that tab-wide
 * scope is the documented, intended behavior). Everything else passes through.
 *
 * Pure and total: never throws, so a paused request is always answerable.
 * Fail-OPEN (no rule / not active / expired / evaluation error / no matching
 * block pattern) -> pass through. A policy bug must never hang or break a page.
 */
export function decideFetchRequest(rule: DelegationRule | null, url: string): FetchDecision {
  if (!rule || !rule.isActive) return { block: false, reason: '' };
  try {
    if (isTimeBoundExpired(rule.scope.timeBound)) return { block: false, reason: '' };
    for (const pattern of rule.scope.sitePatterns) {
      if (pattern.action === 'block' && matchUrlPattern(url, pattern.pattern)) {
        return { block: true, reason: `Blocked by site rule: ${pattern.pattern}` };
      }
    }
    return { block: false, reason: '' };
  } catch {
    return { block: false, reason: '' };
  }
}

/**
 * Whether a rule carries at least one explicit site `block` pattern — i.e.
 * something the CDP layer can actually enforce. A rule with no block pattern
 * has nothing to enforce off-realm, so attaching would only show the debugger
 * banner for no benefit.
 */
export function ruleHasBlockPattern(rule: DelegationRule | null): boolean {
  if (!rule) return false;
  return rule.scope.sitePatterns.some((p) => p.action === 'block');
}

/** Inputs for deciding whether a tab warrants CDP enforcement. */
export interface EnforceTabInput {
  /** `settings.cdpEnforcementEnabled`. */
  settingEnabled: boolean;
  /** Whether an agent is currently detected in the tab. */
  hasAgent: boolean;
  /** The delegation rule that governs the tab (per-agent, else session-wide). */
  rule: DelegationRule | null;
}

/**
 * Whether a tab should have a CDP enforcement session attached: the feature is
 * on, an agent is present, an active/unexpired delegation governs the tab, AND
 * that rule has at least one site `block` pattern to enforce. The block-pattern
 * requirement keeps the debugger banner off when there is nothing the CDP layer
 * can actually enforce (the capability-level block stays page-realm).
 */
export function shouldEnforceTab(input: EnforceTabInput): boolean {
  if (!input.settingEnabled) return false;
  if (!input.hasAgent) return false;
  const rule = input.rule;
  if (!rule || !rule.isActive) return false;
  if (isTimeBoundExpired(rule.scope.timeBound)) return false;
  if (!ruleHasBlockPattern(rule)) return false;
  return true;
}

/** Diff between the tabs that should be enforced and those currently attached. */
export function reconcile(
  desired: Set<number>,
  attached: Iterable<number>,
): { toAttach: number[]; toDetach: number[] } {
  const attachedSet = new Set(attached);
  const toAttach: number[] = [];
  const toDetach: number[] = [];
  for (const id of desired) {
    if (!attachedSet.has(id)) toAttach.push(id);
  }
  for (const id of attachedSet) {
    if (!desired.has(id)) toDetach.push(id);
  }
  return { toAttach, toDetach };
}

// --- Orchestration (impure: drives chrome.debugger directly) ---------------

type GetRuleForTab = (tabId: number) => DelegationRule | null;
type OnBlock = (tabId: number, url: string, reason: string) => void;

let getRuleForTab: GetRuleForTab | null = null;
let onBlock: OnBlock | null = null;
let listenersRegistered = false;
const attachedTabs = new Set<number>();
/** Tabs whose attach() is in flight — guards against a double-attach race. */
const attaching = new Set<number>();
/** Serializes reconcileTabs runs so overlapping calls can't interleave. */
let reconcileChain: Promise<void> = Promise.resolve();

/** Whether `chrome.debugger` (with the methods we need) is available. */
function debuggerAvailable(): boolean {
  return (
    typeof chrome !== 'undefined' &&
    !!chrome.debugger &&
    typeof chrome.debugger.attach === 'function' &&
    typeof chrome.debugger.sendCommand === 'function'
  );
}

/**
 * Wire the enforcement layer. Registers the `Fetch.requestPaused` and
 * `onDetach` listeners once. Safe to call when `chrome.debugger` is absent
 * (no-op) so the background worker initializes in environments without it.
 */
export function initCdpEnforcement(opts: { getRuleForTab: GetRuleForTab; onBlock?: OnBlock }): void {
  getRuleForTab = opts.getRuleForTab;
  onBlock = opts.onBlock ?? null;
  if (listenersRegistered || !debuggerAvailable()) return;
  chrome.debugger.onEvent.addListener(handleDebuggerEvent);
  chrome.debugger.onDetach.addListener(handleDebuggerDetach);
  listenersRegistered = true;
}

/**
 * Handle a CDP instrumentation event. Only `Fetch.requestPaused` is acted on.
 * Every paused request is answered exactly once (continue or fail) — leaving
 * one unanswered would hang the page, so unknown/stale events are continued.
 */
function handleDebuggerEvent(source: chrome.debugger.Debuggee, method: string, params?: object): void {
  if (method !== 'Fetch.requestPaused') return;
  const tabId = source.tabId;
  const requestId = (params as { requestId?: string } | undefined)?.requestId;
  if (tabId === undefined || !requestId) return;

  // An event for a tab we are not enforcing (a stale session, or one already
  // detached) must still be released, never blocked.
  if (!attachedTabs.has(tabId)) {
    void continueRequest(tabId, requestId);
    return;
  }

  const url = (params as { request?: { url?: string } } | undefined)?.request?.url ?? '';
  const rule = getRuleForTab ? getRuleForTab(tabId) : null;
  const decision = decideFetchRequest(rule, url);
  if (decision.block) {
    void failRequest(tabId, requestId);
    if (onBlock) {
      try { onBlock(tabId, url, decision.reason); } catch { /* reporting is non-critical */ }
    }
  } else {
    void continueRequest(tabId, requestId);
  }
}

/**
 * Browser terminated our debugger session for a tab (tab closed, DevTools
 * opened, or another client took the slot). Drop it from the attached set so we
 * fall back to page-realm enforcement — never leave a phantom-attached tab.
 */
function handleDebuggerDetach(source: chrome.debugger.Debuggee): void {
  if (source.tabId !== undefined) {
    attachedTabs.delete(source.tabId);
  }
}

async function continueRequest(tabId: number, requestId: string): Promise<void> {
  if (!debuggerAvailable()) return;
  try {
    await chrome.debugger.sendCommand({ tabId }, 'Fetch.continueRequest', { requestId });
  } catch {
    // The request may already be gone (navigation, tab close). Nothing to do.
  }
}

async function failRequest(tabId: number, requestId: string): Promise<void> {
  if (!debuggerAvailable()) return;
  try {
    await chrome.debugger.sendCommand({ tabId }, 'Fetch.failRequest', {
      requestId,
      errorReason: 'BlockedByClient',
    });
  } catch {
    // Best-effort: if the fail command itself fails the request is already gone.
  }
}

/**
 * Attach a CDP session to a tab and enable request interception. Fail-safe: on
 * any failure (DevTools open, another CDP client owns the tab, a restricted
 * URL) it leaves the tab unattached and returns false rather than throwing —
 * the page-realm interceptor stays in force.
 */
export async function attachTab(tabId: number): Promise<boolean> {
  if (attachedTabs.has(tabId)) return true;
  // A concurrent attachTab for the same tab is already in flight. Backing off
  // (rather than racing a second chrome.debugger.attach) avoids the second
  // attach rejecting and its catch detaching the first call's live session.
  if (attaching.has(tabId)) return false;
  if (!debuggerAvailable()) return false;
  attaching.add(tabId);
  try {
    await chrome.debugger.attach({ tabId }, CDP_PROTOCOL_VERSION);
    await chrome.debugger.sendCommand({ tabId }, 'Fetch.enable', {});
    attachedTabs.add(tabId);
    return true;
  } catch {
    // attach() may have partially succeeded (e.g. Fetch.enable failed) — detach
    // so we never leave a tab attached-but-uncontrolled.
    try { await chrome.debugger.detach({ tabId }); } catch { /* may not be attached */ }
    return false;
  } finally {
    attaching.delete(tabId);
  }
}

/** Detach the CDP session from a tab, if attached. */
export async function detachTab(tabId: number): Promise<void> {
  if (!attachedTabs.has(tabId)) return;
  attachedTabs.delete(tabId);
  if (!debuggerAvailable()) return;
  try {
    await chrome.debugger.detach({ tabId });
  } catch {
    // Already detached (tab closed / external detach). Set is already cleared.
  }
}

/**
 * Drive the attached set toward `desired`: detach tabs that no longer qualify,
 * attach those that newly do. Detaches run first so a flip from one tab to
 * another never holds two sessions longer than needed.
 */
export function reconcileTabs(desired: Set<number>): Promise<void> {
  // Serialize: chain each run after the previous so two overlapping reconciles
  // (e.g. a detection handler and the cdp-monitor alarm firing together) can't
  // interleave attach/detach decisions made from stale snapshots.
  reconcileChain = reconcileChain.then(() => doReconcile(desired)).catch(() => { /* never reject the chain */ });
  return reconcileChain;
}

async function doReconcile(desired: Set<number>): Promise<void> {
  const { toAttach, toDetach } = reconcile(desired, attachedTabs);
  for (const id of toDetach) {
    await detachTab(id);
  }
  for (const id of toAttach) {
    await attachTab(id);
  }
}

/** Whether a tab currently has an enforcement session attached. */
export function isTabAttached(tabId: number): boolean {
  return attachedTabs.has(tabId);
}

/** Snapshot of attached tab IDs (for diagnostics / tests). */
export function getAttachedTabs(): number[] {
  return Array.from(attachedTabs);
}

/** Reset module state. Test-only. */
export function _resetForTest(): void {
  attachedTabs.clear();
  attaching.clear();
  reconcileChain = Promise.resolve();
  getRuleForTab = null;
  onBlock = null;
  listenersRegistered = false;
}
