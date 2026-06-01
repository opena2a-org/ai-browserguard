/**
 * MAIN world content script — capability boundary interceptor.
 *
 * Runs in the page's JavaScript context (not the extension isolated world).
 * Intercepts low-level browser APIs that agents use to bypass DOM event
 * interception: window.open, history.pushState/replaceState,
 * HTMLFormElement.prototype.submit, and the Navigation API.
 *
 * IMPORTANT: This script CANNOT use any chrome.* APIs.
 *
 * Communication with the isolated content script uses a one-shot
 * `MessageChannel` handshake. The ISOLATED world creates the channel and
 * transfers `port2` to this script via a single `window.postMessage` with
 * `port2` in the transfer list. After this script captures the port, all
 * subsequent traffic flows through the entangled `MessagePort` pair —
 * invisible to any other listener on `window`.
 *
 * SECURITY: the bootstrap listener uses `{ capture: true, once: true }` and
 * is registered synchronously at script load. Because both content scripts
 * declare `run_at: "document_start"` in `manifest.json` (and ISOLATED is
 * declared first, MAIN second), the bootstrap envelope is dispatched after
 * MAIN's listener attaches and before any page inline script can register
 * a competing `'message'` listener.
 */

import { installNetworkInterceptor } from './network-interceptor';
import {
  MSG_BRIDGE_BOOTSTRAP,
  MSG_RULE_UPDATE,
  MSG_ACTION,
  MSG_ALLOW_ONCE,
  MSG_CDP_DETECTED,
  MSG_NETWORK_EVENT,
  MSG_KILL_SWITCH,
} from './bridge-protocol';
import type { BridgeMessage } from './bridge-protocol';

interface InterceptorRule {
  isActive: boolean;
  expiresAt: string | null;
  actionRestrictions: Array<{ capability: string; action: 'allow' | 'block' }>;
  sitePatterns: Array<{ pattern: string; action: 'allow' | 'block' }>;
}

let activeRule: InterceptorRule | null = null;

/**
 * P1-2 hard-block sentinel. When the kill switch fires, the background
 * service worker dispatches `KILL_SWITCH_ACTIVATE` to every content script;
 * each ISOLATED-side handler forwards an `MSG_KILL_SWITCH {active: true}`
 * envelope over the bridge to MAIN. While this flag is set, every
 * capability check returns blocked — even for capabilities the user's
 * delegation rule would normally allow. The flag clears when the user
 * resets the kill switch (background broadcasts `KILL_SWITCH_RESET` to
 * tabs, ISOLATED forwards `MSG_KILL_SWITCH {active: false}` over the
 * bridge).
 *
 * Rationale: the MAIN-world wrappers (window.open, history.pushState,
 * form.submit, Navigation API) cannot be safely unwrapped after install
 * because page code may have captured references to the originals. A
 * hard-block sentinel replaces "remove the wrappers" with "make every
 * wrapper deny," giving the kill switch synchronous effect against any
 * in-flight agent action that races the async kill-switch broadcast.
 *
 * The flag overrides allow-once: a one-shot override granted before the
 * kill switch fired does NOT permit subsequent calls while the sentinel is
 * active. The kill switch is the higher-priority signal.
 */
let killSwitchActive = false;

/**
 * Private port to the ISOLATED-world content script. Set exactly once when
 * the bootstrap envelope is received; after that, all traffic flows through
 * this port and the `window` 'message' listener is detached.
 */
let isolatedWorldPort: MessagePort | null = null;

/**
 * Network events that fired before the bootstrap completed. The interceptor
 * installs `fetch`/`XHR` wrappers synchronously at script load, which means
 * the wrappers may observe page-initiated requests in the same tick the
 * bootstrap is still being delivered. Buffer such events and flush them when
 * the port is ready.
 */
const pendingPortMessages: BridgeMessage[] = [];

function sendToIsolated(message: BridgeMessage): void {
  if (isolatedWorldPort) {
    isolatedWorldPort.postMessage(message);
  } else {
    pendingPortMessages.push(message);
  }
}

/**
 * One-time overrides granted via the "Allow once" notification button.
 * Each entry is a `${capability}:${url}` key. The interceptors check this
 * set before enforcing the active rule, and consume (remove) the entry on
 * first use so that the exception applies exactly once.
 */
const allowedOnce: Set<string> = new Set();

/**
 * Returns true and removes the entry if a one-time override exists for this
 * capability + url combination.
 */
function consumeAllowedOnce(capability: string, url: string): boolean {
  const key = `${capability}:${url}`;
  if (allowedOnce.has(key)) {
    allowedOnce.delete(key);
    return true;
  }
  return false;
}

/** Glob-style URL pattern matching (mirrors monitor.ts matchSitePattern). */
export function matchesPattern(url: string, pattern: string): boolean {
  try {
    if (!pattern.includes('://')) {
      const hostname = new URL(url).hostname;
      const regexStr = pattern
        .replace(/\./g, '\\.')
        .replace(/\*\*/g, '\x00') // placeholder to protect double-star from single-star pass
        .replace(/\*/g, '[^.]*')
        .replace(/\x00/g, '.*');  // restore double-star as any-depth wildcard
      return new RegExp(`^${regexStr}$`).test(hostname);
    }
    const regexStr = pattern
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\\\*/g, '.*');
    return new RegExp(`^${regexStr}$`).test(url);
  } catch {
    return false;
  }
}

/**
 * Check whether a capability is allowed under the current active rule.
 *
 * Pass-through when no rule exists: normal browsing is never blocked.
 * Fail-closed when a rule IS active: actions not explicitly permitted are blocked.
 * This ensures the extension does not break sites (login, navigation) during
 * normal use, while still enforcing boundaries when delegation is configured.
 *
 * Kill-switch hard-block (P1-2): when `killSwitchActive` is set, every
 * capability returns blocked regardless of rule, override, or pass-through
 * state. The check runs FIRST so it cannot be bypassed by a permissive rule
 * or a stale allow-once entry.
 */
export function isActionAllowed(
  capability: string,
  url: string,
  rule: InterceptorRule | null = activeRule
): { allowed: boolean; reason: string } {
  // P1-2 hard-block sentinel — overrides rule and allow-once
  if (killSwitchActive) {
    return { allowed: false, reason: 'Kill switch active — all capabilities blocked' };
  }
  // No active delegation rule → pass through (normal browsing, no agent delegation)
  if (!rule || !rule.isActive) {
    return { allowed: true, reason: 'No active delegation rule — pass-through' };
  }
  if (rule.expiresAt && new Date(rule.expiresAt).getTime() < Date.now()) {
    return { allowed: false, reason: 'Delegation has expired' };
  }

  // Blocked site patterns take precedence
  for (const p of rule.sitePatterns) {
    if (matchesPattern(url, p.pattern) && p.action === 'block') {
      return { allowed: false, reason: `Site blocked by pattern: ${p.pattern}` };
    }
  }

  const restriction = rule.actionRestrictions.find((r) => r.capability === capability);
  if (!restriction) {
    return { allowed: false, reason: `Capability '${capability}' not permitted` };
  }
  return {
    allowed: restriction.action === 'allow',
    reason: restriction.action === 'allow'
      ? 'Allowed by delegation rule'
      : `'${capability}' blocked by delegation rule`,
  };
}

/** Report an intercepted action back to the isolated world via the bridge port. */
function reportAction(
  capability: string,
  url: string,
  blocked: boolean,
  reason: string
): void {
  sendToIsolated({
    type: MSG_ACTION,
    capability,
    url,
    blocked,
    reason,
    timestamp: new Date().toISOString(),
  });
}

// ── Secure-context guard ─────────────────────────────────────────────────────
// This script runs in the MAIN world (page JS context). Only install API
// intercepts on secure origins — http: pages do not support Web Crypto APIs
// and are not a target environment for agent-assisted browsing sessions.
// The check uses `!== false` so that undefined (older runtimes, test env)
// is treated as secure and the module proceeds normally.
if (globalThis.isSecureContext !== false) {

// ── CDP stack trace detection ────────────────────────────────────────────────
// When automation frameworks (Playwright, Puppeteer) execute code via CDP's
// Runtime.evaluate or Runtime.callFunctionOn, the V8 call stack contains
// framework-specific signatures that cannot be hidden. We intercept
// Error.prepareStackTrace to inspect structured call sites as they are created.

/** Known stack trace patterns for automation frameworks. */
const CDP_STACK_PATTERNS = [
  { pattern: /UtilityScript/, framework: 'playwright' },
  { pattern: /__puppeteer_evaluation_script__/, framework: 'puppeteer' },
  { pattern: /pptr:/, framework: 'puppeteer' },
  { pattern: /ExecutionContext\._evaluateInternal/, framework: 'puppeteer' },
  // Selenium: ChromeDriver injects via callFunction wrapper
  // Verified against real Selenium 4.41 + ChromeDriver 146 + Chrome 145
  { pattern: /callFunction\b/, framework: 'selenium' },
] as const;

let cdpDetectionReported = false;

/** Report a CDP detection to the isolated world content script. */
function reportCdpDetection(framework: string, detail: string, signals: Record<string, unknown>): void {
  if (cdpDetectionReported) return;
  cdpDetectionReported = true;
  sendToIsolated({
    type: MSG_CDP_DETECTED,
    framework,
    detail,
    signals,
    timestamp: new Date().toISOString(),
  });
}

/**
 * Check the call stack of the CURRENT execution for CDP automation patterns.
 * Call this from within intercepted API functions (window.open, form.submit, etc.)
 * to detect if the call originated from CDP-evaluated code.
 *
 * Returns true if a CDP framework pattern was found in the stack, meaning the
 * current call was initiated by an automation agent rather than by the user.
 */
function probeCallStack(): boolean {
  try {
    const stack = new Error('__abg_probe__').stack ?? '';
    for (const { pattern, framework } of CDP_STACK_PATTERNS) {
      if (pattern.test(stack)) {
        if (!cdpDetectionReported) {
          reportCdpDetection(framework, `Detected ${framework} via intercepted API call stack.`, {
            stackSnippet: stack.substring(0, 500),
          });
        }
        return true;
      }
    }
  } catch {
    // Do not let probe errors affect page functionality
  }
  return false;
}

// Install Error.prepareStackTrace trap (V8-specific).
// This intercepts ALL Error creation in the page context, allowing us to
// detect CDP-evaluated code even when it doesn't call our intercepted APIs.
const _originalPrepareStackTrace = (Error as unknown as Record<string, unknown>).prepareStackTrace as
  ((err: Error, sites: NodeJS.CallSite[]) => string) | undefined;

(Error as unknown as Record<string, unknown>).prepareStackTrace = function (
  err: Error,
  callSites: NodeJS.CallSite[],
): string {
  if (!cdpDetectionReported) {
    try {
      for (const site of callSites) {
        const fnName = site.getFunctionName() ?? '';
        const typeName = site.getTypeName() ?? '';
        const fileName = site.getFileName() ?? '';
        const combined = `${typeName}.${fnName} ${fileName}`;

        for (const { pattern, framework } of CDP_STACK_PATTERNS) {
          if (pattern.test(combined) || pattern.test(fnName) || pattern.test(typeName) || pattern.test(fileName)) {
            reportCdpDetection(framework, `Detected ${framework} via Error.prepareStackTrace trap.`, {
              typeName, fnName, fileName,
            });
            break;
          }
        }
        if (cdpDetectionReported) break;
      }
    } catch {
      // Never let inspection errors propagate
    }
  }

  // Delegate to original or produce default format
  if (_originalPrepareStackTrace) {
    return _originalPrepareStackTrace(err, callSites);
  }
  return `${err}\n${callSites.map((s) => `    at ${s}`).join('\n')}`;
};

/** Handle messages received from the ISOLATED-world content script via the port. */
function handleIsolatedMessage(e: MessageEvent): void {
  const data = e.data as BridgeMessage | undefined;
  if (!data || typeof data.type !== 'string') return;

  if (data.type === MSG_RULE_UPDATE) {
    activeRule = (data.rule as InterceptorRule | null) ?? null;
    return;
  }

  if (data.type === MSG_ALLOW_ONCE) {
    const capability = data.capability as string;
    const url = data.url as string;
    if (capability && url) {
      allowedOnce.add(`${capability}:${url}`);
    }
    return;
  }

  if (data.type === MSG_KILL_SWITCH) {
    // Kill-switch sentinel (P1-2). When active, every capability check in
    // isActionAllowed returns blocked, regardless of the active delegation
    // rule or any prior allow-once entry. Clearing the flag (on
    // KILL_SWITCH_RESET) restores normal rule processing without losing
    // the existing activeRule.
    if (typeof data.active === 'boolean') {
      killSwitchActive = data.active;
      // On activation, also purge any pending allow-once entries — they
      // were granted by the user before the emergency, but the emergency
      // is the higher-priority signal.
      if (killSwitchActive) {
        allowedOnce.clear();
      }
    }
    return;
  }
}

/**
 * Bootstrap listener — captures `port2` transferred by ISOLATED, then detaches.
 *
 * Defense: the listener runs synchronously at MAIN script load (before any
 * page inline script can register a competing `'message'` listener), and uses
 * `{ capture: true }`. The listener detaches itself only after successfully
 * capturing the port — a port-less or malformed envelope is ignored without
 * burning the listener (which would otherwise be a trivial DoS against the
 * bridge by any page that posts a bootstrap-shaped message first).
 */
function bootstrapListener(e: MessageEvent): void {
  if (e.source !== window) return;
  const data = e.data as { type?: unknown } | null | undefined;
  if (!data || data.type !== MSG_BRIDGE_BOOTSTRAP) return;
  if (e.ports.length !== 1) return;
  if (isolatedWorldPort) return; // already bootstrapped

  isolatedWorldPort = e.ports[0]!;
  isolatedWorldPort.onmessage = handleIsolatedMessage;
  isolatedWorldPort.start();
  // Detach manually — only after a SUCCESSFUL port capture — so a malformed
  // bootstrap envelope cannot deny-of-service the real one.
  window.removeEventListener('message', bootstrapListener, { capture: true });

  // Flush any buffered messages that fired before bootstrap completed.
  while (pendingPortMessages.length > 0) {
    const msg = pendingPortMessages.shift();
    if (msg) isolatedWorldPort.postMessage(msg);
  }
}

window.addEventListener('message', bootstrapListener, { capture: true });

// ── window.open (open-tab capability) ───────────────────────────────────────
const _originalOpen = window.open.bind(window);
window.open = function (
  url?: string | URL,
  target?: string,
  features?: string
): Window | null {
  const fromAgent = probeCallStack();
  if (!fromAgent) return _originalOpen(url, target, features); // user-initiated — pass through
  const urlStr = url?.toString() ?? window.location.href;
  if (consumeAllowedOnce('open-tab', urlStr)) return _originalOpen(url, target, features);
  const { allowed, reason } = isActionAllowed('open-tab', urlStr);
  reportAction('open-tab', urlStr, !allowed, reason);
  if (!allowed) return null;
  return _originalOpen(url, target, features);
};

// ── HTMLFormElement.prototype.submit (bypasses the 'submit' DOM event) ──────
const _originalFormSubmit = HTMLFormElement.prototype.submit;
HTMLFormElement.prototype.submit = function (this: HTMLFormElement): void {
  const fromAgent = probeCallStack();
  if (!fromAgent) { _originalFormSubmit.call(this); return; } // user-initiated — pass through
  const url = this.action || window.location.href;
  if (consumeAllowedOnce('submit-form', url)) { _originalFormSubmit.call(this); return; }
  const { allowed, reason } = isActionAllowed('submit-form', url);
  reportAction('submit-form', url, !allowed, reason);
  if (!allowed) return;
  _originalFormSubmit.call(this);
};

// ── history.pushState (SPA navigation) ──────────────────────────────────────
const _originalPushState = history.pushState.bind(history);
history.pushState = function (
  state: unknown,
  unused: string,
  url?: string | URL | null
): void {
  const fromAgent = probeCallStack();
  if (!fromAgent) { _originalPushState(state, unused, url); return; } // user-initiated — pass through
  const urlStr = url?.toString() ?? window.location.href;
  if (consumeAllowedOnce('navigate', urlStr)) { _originalPushState(state, unused, url); return; }
  const { allowed, reason } = isActionAllowed('navigate', urlStr);
  reportAction('navigate', urlStr, !allowed, reason);
  if (!allowed) return;
  _originalPushState(state, unused, url);
};

// ── history.replaceState (SPA navigation) ───────────────────────────────────
const _originalReplaceState = history.replaceState.bind(history);
history.replaceState = function (
  state: unknown,
  unused: string,
  url?: string | URL | null
): void {
  const fromAgent = probeCallStack();
  if (!fromAgent) { _originalReplaceState(state, unused, url); return; } // user-initiated — pass through
  const urlStr = url?.toString() ?? window.location.href;
  if (consumeAllowedOnce('navigate', urlStr)) { _originalReplaceState(state, unused, url); return; }
  const { allowed, reason } = isActionAllowed('navigate', urlStr);
  reportAction('navigate', urlStr, !allowed, reason);
  if (!allowed) return;
  _originalReplaceState(state, unused, url);
};

// ── Navigation API (Chrome 102+) — catches location.href = assignments ──────
type NavigationEventTarget = EventTarget & {
  addEventListener(
    type: 'navigate',
    listener: (e: NavigateEvent) => void
  ): void;
};
interface NavigateEvent extends Event {
  readonly isTrusted: boolean;
  readonly destination: { readonly url: string };
  preventDefault(): void;
}

const nav = (window as unknown as Record<string, unknown>).navigation as
  NavigationEventTarget | undefined;
if (nav) {
  nav.addEventListener('navigate', (e: NavigateEvent) => {
    if (e.isTrusted) return; // user-initiated navigation — do not intercept
    const url = e.destination?.url ?? window.location.href;
    if (consumeAllowedOnce('navigate', url)) return;
    const { allowed, reason } = isActionAllowed('navigate', url);
    reportAction('navigate', url, !allowed, reason);
    if (!allowed) {
      try { e.preventDefault(); } catch { /* some navigate events are not cancellable */ }
    }
  });
}

// ── Network activity interception ──────────────────────────────────────────
// Install fetch/XHR wrappers to observe network requests. Events are relayed
// to the isolated world content script via the bridge port, which forwards
// them to the background service worker for the Network Activity panel.
// Guard: only install when fetch and XMLHttpRequest are available (browser context).
if (typeof window.fetch === 'function' && typeof XMLHttpRequest !== 'undefined') {
  installNetworkInterceptor((event) => {
    sendToIsolated({ type: MSG_NETWORK_EVENT, event });
  });
}

} // end secure-context guard
