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
 * The same session also enables the CDP `Page` domain so Chrome reports a
 * download starting in the tab (`Page.downloadWillBegin`). That report is the
 * only tab-level link between a download and an agent this extension can get
 * with its permissions (a chrome.downloads item carries no tab id), and it is
 * what download cancellation rests on (see download-monitor.ts).
 *
 * Must run in the background service worker — `chrome.debugger` is not
 * available in content scripts.
 */

import type { DelegationRule } from '../types/delegation';
import { isTimeBoundExpired } from '../delegation/rules';
import { matchUrlPattern } from '../url/match-pattern';
import {
  matchTabDownloadStart,
  TAB_DOWNLOAD_START_WINDOW_MS,
  type DownloadToMatch,
  type RecentDownload,
  type TabDownloadStart,
} from './download-monitor';

/** Remote debugging protocol version requested on attach. */
export const CDP_PROTOCOL_VERSION = '1.3';

/**
 * How long a download item still waits for its start once every session that
 * could report it has answered a command sent after the item arrived (see
 * {@link awaitTabDownloadStart}).
 */
export const TAB_DOWNLOAD_START_GRACE_MS = 250;

/**
 * The command that asks a download-watched session whether it has a start
 * left to report. The browser answers it without involving the page, so a busy
 * page does not hold the answer back, and it changes nothing.
 */
const DOWNLOAD_START_BARRIER_METHOD = 'Page.getNavigationHistory';

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

/**
 * Scope note — WebSocket. The CDP `Fetch` domain does NOT pause WebSocket
 * handshakes (measured on Chrome 145), so `decideFetchRequest` never sees a
 * `ws://`/`wss://` connection. `Network.setBlockedURLs` can block ws in a clean
 * session but proved UNRELIABLE on the live extension's busier debugger session
 * (Fetch + Network + detection sharing one client) — it raced the handshake and
 * leaked intermittently. Rather than ship a flaky block behind a confident
 * claim, this layer does not attempt WebSocket blocking: a WebSocket to a
 * blocked domain is the one egress vector it does not close, disclosed as such
 * (docs/architecture §8, ADR-007). Deterministic ws blocking needs
 * `declarativeNetRequest` (`resourceTypes: ['websocket']`, per-tab session
 * rules) — a new permission deferred to ADR-008 R2, not this increment.
 */

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
/** Attached tabs whose session has the Page domain enabled (download starts reported). */
const downloadWatchedTabs = new Set<number>();
/** Download starts reported on our sessions and not yet matched, keyed by guid. */
const downloadStarts = new Map<string, TabDownloadStart>();
/** Download items waiting for their start to be reported. */
const downloadStartWaiters = new Set<() => void>();
/** Download items that took a start, by download id, with when they took it. */
const matchedDownloads = new Map<number, number>();

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
 * Handle a CDP instrumentation event. `Fetch.requestPaused` and
 * `Page.downloadWillBegin` are acted on; every other event is ignored.
 * Every paused request is answered exactly once (continue or fail) — leaving
 * one unanswered would hang the page, so unknown/stale events are continued.
 */
function handleDebuggerEvent(source: chrome.debugger.Debuggee, method: string, params?: object): void {
  if (method === 'Page.downloadWillBegin') {
    recordDownloadStart(source.tabId, params);
    return;
  }
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
    downloadWatchedTabs.delete(source.tabId);
  }
}

/**
 * Drop download starts older than the matching window, and forget items that
 * took a start once they are too old to compete for one (created more than
 * two windows ago).
 */
function pruneDownloadStarts(now: number): void {
  for (const [guid, start] of downloadStarts) {
    if (now - start.at > TAB_DOWNLOAD_START_WINDOW_MS) downloadStarts.delete(guid);
  }
  for (const [id, at] of matchedDownloads) {
    if (now - at > 2 * TAB_DOWNLOAD_START_WINDOW_MS) matchedDownloads.delete(id);
  }
}

/**
 * Keep a `Page.downloadWillBegin` reported on a session we hold, for the
 * download item it belongs to. A report for a tab we are not attached to is
 * dropped: only our own session on that tab says the download started there.
 */
function recordDownloadStart(tabId: number | undefined, params?: object): void {
  if (tabId === undefined || !attachedTabs.has(tabId)) return;
  const p = params as { frameId?: unknown; guid?: unknown; url?: unknown } | undefined;
  if (typeof p?.guid !== 'string' || typeof p.url !== 'string' || !p.url) return;
  const now = Date.now();
  pruneDownloadStarts(now);
  downloadStarts.set(p.guid, {
    tabId,
    frameId: typeof p.frameId === 'string' ? p.frameId : '',
    guid: p.guid,
    url: p.url,
    at: now,
  });
  for (const wake of Array.from(downloadStartWaiters)) wake();
}

/**
 * Take (consume) the reported download start that belongs to `info`, or null.
 * Each start is matched to at most one download item. `others` are the other
 * download items Chrome has created lately; those that took a start are left
 * out, and while more of the rest share the start's URL than there are reports
 * for it, none is matched (see matchTabDownloadStart).
 */
export function takeTabDownloadStart(
  info: DownloadToMatch,
  now: number = Date.now(),
  others: Iterable<RecentDownload> = [],
): TabDownloadStart | null {
  pruneDownloadStarts(now);
  const unmatched = Array.from(others).filter((d) => !matchedDownloads.has(d.id));
  const match = matchTabDownloadStart(downloadStarts.values(), info, now, unmatched);
  if (match) {
    downloadStarts.delete(match.guid);
    if (info.id !== undefined) matchedDownloads.set(info.id, now);
  }
  return match;
}

/**
 * The download items Chrome created recently enough to share a start with one
 * being matched now. Empty when chrome.downloads cannot be searched here; null
 * when the search failed, so nothing is matched on a list we could not read.
 */
async function otherRecentDownloads(now: number): Promise<RecentDownload[] | null> {
  if (typeof chrome === 'undefined' || typeof chrome.downloads?.search !== 'function') return [];
  try {
    const items = await chrome.downloads.search({
      startedAfter: new Date(now - 2 * TAB_DOWNLOAD_START_WINDOW_MS).toISOString(),
    });
    return items ?? [];
  } catch {
    return null;
  }
}

/**
 * The download start that belongs to `info`, when none has been reported yet
 * waiting for it (Chrome does not order the CDP event against
 * chrome.downloads.onCreated), or while another download of its URL leaves the
 * reports so far ambiguous. Resolves null at once when no session of ours
 * could report one.
 *
 * A download started in a tab without our session is never reported, so the
 * wait does not run out the matching window: each watched session is sent a
 * command. Chrome sends a session's events and replies in order, and reports a
 * download start on the session before the item (0-6 ms before
 * chrome.downloads.onCreated, measured on Chrome 145), so once every session
 * has answered or failed to, a start one of them reported for this item, or
 * for another download of its URL created before it, has normally been
 * recorded. The item then waits {@link TAB_DOWNLOAD_START_GRACE_MS} more, a
 * margin for an event that reaches this worker after the reply that followed
 * it, and never longer than {@link TAB_DOWNLOAD_START_WINDOW_MS} in all. A
 * report still ambiguous then stays unmatched.
 */
export function awaitTabDownloadStart(info: DownloadToMatch): Promise<TabDownloadStart | null> {
  const watched = Array.from(downloadWatchedTabs);
  const wait = watched.length > 0;
  return new Promise((resolve) => {
    let settled = false;
    let windowTimer: ReturnType<typeof setTimeout> | undefined;
    let graceTimer: ReturnType<typeof setTimeout> | undefined;
    const finish = (start: TabDownloadStart | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(windowTimer);
      clearTimeout(graceTimer);
      downloadStartWaiters.delete(wake);
      resolve(start);
    };
    const check = async (): Promise<boolean> => {
      const others = await otherRecentDownloads(Date.now());
      if (settled || others === null) return settled;
      const start = takeTabDownloadStart(info, Date.now(), others);
      if (start) finish(start);
      return start !== null;
    };
    const wake = () => { void check(); };
    // A last check at the end of the grace, so a start reported while an
    // earlier check was still listing downloads is not lost.
    const endOfGrace = () => { void check().then((found) => { if (!found) finish(null); }); };
    if (wait) {
      windowTimer = setTimeout(() => finish(null), TAB_DOWNLOAD_START_WINDOW_MS);
      downloadStartWaiters.add(wake);
    }
    void check().then((found) => {
      if (found || settled) return;
      if (!wait) {
        finish(null);
        return;
      }
      void Promise.all(watched.map(sessionAnswered)).then(() => {
        if (!settled) graceTimer = setTimeout(endOfGrace, TAB_DOWNLOAD_START_GRACE_MS);
      });
    });
  });
}

/**
 * Resolves once the session on `tabId` has answered a command sent now, or
 * failed to (a session that has gone reports nothing more). Never rejects.
 */
async function sessionAnswered(tabId: number): Promise<void> {
  if (!debuggerAvailable()) return;
  try {
    await chrome.debugger.sendCommand({ tabId }, DOWNLOAD_START_BARRIER_METHOD, {});
  } catch {
    // An error reply comes back in order like any other, and a session that
    // has gone reports nothing more.
  }
}

/** Whether an attached session on `tabId` reports the downloads started there. */
export function isTabDownloadWatched(tabId: number): boolean {
  return downloadWatchedTabs.has(tabId);
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
    // Download starts in this tab. Best-effort: without it the session still
    // enforces blocked sites, and downloads here are only recorded.
    try {
      await chrome.debugger.sendCommand({ tabId }, 'Page.enable', {});
      if (attachedTabs.has(tabId)) downloadWatchedTabs.add(tabId);
    } catch { /* downloads in this tab stay record-only */ }
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
  downloadWatchedTabs.delete(tabId);
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
  downloadWatchedTabs.clear();
  downloadStarts.clear();
  downloadStartWaiters.clear();
  matchedDownloads.clear();
  reconcileChain = Promise.resolve();
  getRuleForTab = null;
  onBlock = null;
  listenersRegistered = false;
}
