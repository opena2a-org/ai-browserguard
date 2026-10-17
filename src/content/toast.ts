/**
 * Inline toast notifications for blocked actions.
 *
 * Injects a small slide-in toast at the bottom-right of the page when
 * the extension blocks an agent action. Provides immediate, in-context
 * feedback so the user knows why something stopped working.
 *
 * Runs in the ISOLATED world content script — has DOM access and can
 * communicate with the background via chrome.runtime.
 */

import { classifyViolationSeverity, allowsOneTimeOverride } from '../alerts/boundary';
import type { AgentCapability } from '../types/agent';

const TOAST_CONTAINER_ID = 'abg-toast-container';
const MAX_VISIBLE_TOASTS = 3;
const AUTO_DISMISS_MS = 8000;
const CRITICAL_AUTO_DISMISS_MS = 0; // stays until user interacts

/** Capability labels for user-friendly display. */
const CAPABILITY_LABELS: Record<string, string> = {
  'submit-form': 'form submission',
  'open-tab': 'new tab',
  'navigate': 'navigation',
  'click': 'click',
  'type-text': 'text input',
  'download-file': 'file download',
  'modify-dom': 'page modification',
  'execute-script': 'script execution',
  'read-dom': 'page reading',
  'screenshot': 'screenshot',
  'close-tab': 'tab close',
  'network-request': 'network request',
};

/** A rendered notice and the count of identical blocks it stands for. */
interface ToastGroup {
  /** Capability, URL and reason of the block, the identity of the notice. */
  key: string;
  count: number;
  /** The "Blocked <label>." line without a count. */
  label: string;
  what: HTMLElement;
  rearm: () => void;
  remove: () => void;
}

const toastGroups = new WeakMap<Element, ToastGroup>();

/** Severity for determining toast persistence. */
const CRITICAL_CAPABILITIES = new Set(['submit-form', 'execute-script']);

export interface ToastOptions {
  capability: string;
  url: string;
  reason: string;
  /**
   * "Allow once" — one-shot bypass for this exact (capability, url). Shown
   * only when the block's severity is medium or low, the same rule the
   * Chrome notification applies; a high or critical block offers no override.
   */
  onAllowOnce?: () => void;
  /** "Whitelist this site" — permanent allow for the domain. */
  onWhitelist?: (domain: string) => void;
  /** "Settings" — open the popup so the user can review what was blocked. */
  onOpenSettings?: () => void;
  /** Internal dismiss callback. */
  onDismiss?: () => void;
}

/** Extract the registrable domain from a URL for whitelisting. */
function extractDomain(url: string): string | null {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

/**
 * Produce a safe-for-display version of a domain. The toast surfaces this
 * value to the user when they click "Whitelist <domain>", so we must
 * surface a warning marker when the underlying hostname could be confused
 * with a different domain. Two specific cases:
 *
 *   - Punycode IDN labels (`xn--*`) — render as a different Unicode form
 *     in modern browsers, classic homograph vector.
 *   - Mixed-script labels (Latin + Cyrillic, etc.) — the typical Unicode
 *     domain spoof where a Latin `a` is swapped for the Cyrillic
 *     lookalike (`а`).
 *
 * The marker is a textual "(unverified)" suffix rather than an emoji so
 * it lands consistently in screen readers and copy-paste contexts.
 */
export function safeDisplayDomain(domain: string): string {
  if (!domain) return domain;
  const lower = domain.toLowerCase();
  const labels = lower.split('.');
  const hasPunycode = labels.some((l) => l.startsWith('xn--'));
  const hasMixedScript = labels.some((l) => {
    let latin = false;
    let nonLatin = false;
    for (const ch of l) {
      const code = ch.codePointAt(0) ?? 0;
      if (code >= 0x61 && code <= 0x7a) latin = true;
      else if (code >= 0x80) nonLatin = true;
      if (latin && nonLatin) return true;
    }
    return false;
  });
  if (hasPunycode || hasMixedScript) {
    return `${domain} (unverified)`;
  }
  return domain;
}

/** Ensure the toast container element exists in the page. */
function ensureContainer(): HTMLElement {
  let container = document.getElementById(TOAST_CONTAINER_ID);
  if (container) return container;

  container = document.createElement('div');
  container.id = TOAST_CONTAINER_ID;

  // Use a shadow DOM to isolate styles from the host page.
  const shadow = container.attachShadow({ mode: 'closed' });

  const styleEl = document.createElement('style');
  styleEl.textContent = getToastStyles();
  shadow.appendChild(styleEl);

  const inner = document.createElement('div');
  inner.className = 'abg-toast-inner';
  shadow.appendChild(inner);

  // Store reference to the inner container on the host element.
  (container as unknown as { _inner: HTMLElement })._inner = inner;

  document.documentElement.appendChild(container);
  return container;
}

function getInner(container: HTMLElement): HTMLElement {
  return (container as unknown as { _inner: HTMLElement })._inner;
}

const SVG_NS = 'http://www.w3.org/2000/svg';

/**
 * Build the BrowserGuard shield mark as an inline monochrome SVG.
 *
 * Drawn with createElementNS (never an HTML-string sink) so the content script
 * never parses an HTML/SVG string into a page it does not control. Uses
 * `currentColor` so it inherits the toast header's text color. Replaces the
 * former shield emoji, which rendered inconsistently across platforms and is
 * not house-style for product UI.
 */
function buildShieldIcon(): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', '16');
  svg.setAttribute('height', '16');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  const path = document.createElementNS(SVG_NS, 'path');
  path.setAttribute('d', 'M12 2 4 5v6c0 5 3.4 8.4 8 11 4.6-2.6 8-6 8-11V5z');
  svg.appendChild(path);
  return svg;
}

/**
 * Show a toast notification for a blocked action.
 * Returns a cleanup function to remove the toast.
 */
export function showBlockedToast(options: ToastOptions): () => void {
  const {
    capability,
    url,
    reason,
    onAllowOnce,
    onWhitelist,
    onOpenSettings,
    onDismiss,
  } = options;
  const container = ensureContainer();
  const inner = getInner(container);

  // A notice identical to the newest one counts on it instead of stacking, so
  // a burst from one agent cannot push out a notice that differs (#133).
  const key = JSON.stringify([capability, url, reason]);
  const newest = inner.lastElementChild;
  const group = newest ? toastGroups.get(newest) : undefined;
  if (group && group.key === key && !newest!.classList.contains('abg-toast-exit')) {
    group.count += 1;
    group.what.textContent = `${group.label} ×${group.count}`;
    group.rearm();
    return group.remove;
  }

  // Limit visible toasts
  while (inner.children.length >= MAX_VISIBLE_TOASTS) {
    inner.removeChild(inner.firstChild!);
  }

  const toast = document.createElement('div');
  toast.className = 'abg-toast';
  toast.setAttribute('role', 'alert');

  const isCritical = CRITICAL_CAPABILITIES.has(capability);
  const label = CAPABILITY_LABELS[capability] ?? capability;
  const domain = extractDomain(url);

  // Header row: shield icon + BrowserGuard wordmark + close button.
  // The wordmark stays visible for the lifetime of the toast so the user
  // never has to guess which extension blocked the action.
  const header = document.createElement('div');
  header.className = 'abg-toast-header';

  const icon = document.createElement('span');
  icon.className = 'abg-toast-icon';
  icon.setAttribute('aria-hidden', 'true');
  icon.appendChild(buildShieldIcon());

  const brand = document.createElement('span');
  brand.className = 'abg-toast-brand';
  brand.textContent = 'AI Browser Guard';

  const closeBtn = document.createElement('button');
  closeBtn.className = 'abg-toast-close';
  closeBtn.textContent = '×'; // multiplication sign as close glyph
  closeBtn.setAttribute('aria-label', 'Dismiss');
  closeBtn.addEventListener('click', () => {
    removeToast();
    onDismiss?.();
  });

  header.appendChild(icon);
  header.appendChild(brand);
  header.appendChild(closeBtn);

  // Body: what was blocked + why.
  const body = document.createElement('div');
  body.className = 'abg-toast-body';

  const what = document.createElement('div');
  what.className = 'abg-toast-what';
  const whatText = `Blocked ${label}.`;
  what.textContent = whatText;
  body.appendChild(what);

  if (reason) {
    const why = document.createElement('div');
    why.className = 'abg-toast-why';
    why.textContent = reason;
    body.appendChild(why);
  }

  // Quick-action row: Allow once · Whitelist site · Settings.
  // Every block path renders the same set of options so the user has the
  // same recovery affordances regardless of which detector fired. Allow once
  // is withheld for high and critical blocks, classified exactly as the
  // Chrome notification classifies them, so neither surface can let such a
  // block through (#109).
  const actions = document.createElement('div');
  actions.className = 'abg-toast-actions';

  const overridable = allowsOneTimeOverride(
    classifyViolationSeverity(capability as AgentCapability, url),
  );

  if (onAllowOnce && overridable) {
    const allowOnceBtn = document.createElement('button');
    allowOnceBtn.className = 'abg-toast-btn abg-toast-btn-allow';
    allowOnceBtn.textContent = 'Allow once';
    allowOnceBtn.addEventListener('click', () => {
      onAllowOnce();
      removeToast();
    });
    actions.appendChild(allowOnceBtn);
  }

  if (domain && onWhitelist) {
    const whitelistBtn = document.createElement('button');
    whitelistBtn.className = 'abg-toast-btn abg-toast-btn-whitelist';
    whitelistBtn.textContent = `Whitelist ${safeDisplayDomain(domain)}`;
    whitelistBtn.addEventListener('click', () => {
      onWhitelist(domain);
      removeToast();
    });
    actions.appendChild(whitelistBtn);
  }

  if (onOpenSettings) {
    const settingsBtn = document.createElement('button');
    settingsBtn.className = 'abg-toast-btn abg-toast-btn-settings';
    settingsBtn.textContent = 'Settings';
    settingsBtn.addEventListener('click', () => {
      onOpenSettings();
      removeToast();
    });
    actions.appendChild(settingsBtn);
  }

  toast.appendChild(header);
  toast.appendChild(body);
  if (actions.children.length > 0) {
    toast.appendChild(actions);
  }
  inner.appendChild(toast);

  // Animate in
  requestAnimationFrame(() => {
    toast.classList.add('abg-toast-visible');
  });

  let dismissed = false;
  let timeoutId: ReturnType<typeof setTimeout> | undefined;

  const removeToast = () => {
    if (dismissed) return;
    dismissed = true;
    if (timeoutId) clearTimeout(timeoutId);
    toast.classList.remove('abg-toast-visible');
    toast.classList.add('abg-toast-exit');
    setTimeout(() => {
      try { inner.removeChild(toast); } catch { /* already removed */ }
    }, 300); // match CSS transition
  };

  // Auto-dismiss for non-critical; a repeat restarts the timer.
  const dismissMs = isCritical ? CRITICAL_AUTO_DISMISS_MS : AUTO_DISMISS_MS;
  const rearm = () => {
    if (dismissMs <= 0 || dismissed) return;
    if (timeoutId) clearTimeout(timeoutId);
    timeoutId = setTimeout(removeToast, dismissMs);
  };
  rearm();

  toastGroups.set(toast, { key, count: 1, label: whatText, what, rearm, remove: removeToast });

  return removeToast;
}

/** CSS for toast notifications, scoped inside shadow DOM. */
function getToastStyles(): string {
  return `
    .abg-toast-inner {
      /* With both side offsets set, the container spans the page's content
         area less 16px on each side. The offsets of a fixed box are measured
         inside the page's scrollbar; 100vw would count the scrollbar. */
      position: fixed;
      bottom: 16px;
      right: 16px;
      left: 16px;
      z-index: 2147483647;
      display: flex;
      flex-direction: column;
      align-items: flex-end;
      gap: 8px;
      pointer-events: none;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    }

    .abg-toast {
      display: flex;
      flex-direction: column;
      gap: 6px;
      padding: 10px 12px;
      background: #1a1a2e;
      border: 1px solid rgba(6, 182, 212, 0.3);
      border-radius: 8px;
      color: #e0e0e0;
      font-size: 13px;
      line-height: 1.4;
      box-shadow: 0 4px 16px rgba(0, 0, 0, 0.4);
      pointer-events: auto;
      transform: translateX(120%);
      opacity: 0;
      transition: transform 0.3s ease, opacity 0.3s ease;
      /* The width counts the padding and border, so the cap below is the
         whole box: the container's width, which is the content area less
         16px on each side. */
      box-sizing: border-box;
      width: 366px;
      max-width: 100%;
    }

    .abg-toast-visible {
      transform: translateX(0);
      opacity: 1;
    }

    .abg-toast-exit {
      transform: translateX(120%);
      opacity: 0;
    }

    .abg-toast-header {
      display: flex;
      align-items: center;
      gap: 8px;
    }

    .abg-toast-icon {
      flex-shrink: 0;
      width: 18px;
      height: 18px;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 14px;
    }

    .abg-toast-brand {
      flex: 1;
      font-weight: 600;
      font-size: 12px;
      letter-spacing: 0.02em;
      color: #06b6d4;
    }

    .abg-toast-close {
      background: transparent;
      border: none;
      color: #888;
      font-size: 18px;
      line-height: 1;
      padding: 0 4px;
      cursor: pointer;
      transition: color 0.15s;
    }
    .abg-toast-close:hover {
      color: #ccc;
    }

    .abg-toast-body {
      display: flex;
      flex-direction: column;
      gap: 2px;
    }

    .abg-toast-what {
      color: #f0f0f0;
      font-size: 13px;
      font-weight: 500;
    }

    .abg-toast-why {
      color: #a0a0a0;
      font-size: 11px;
      line-height: 1.3;
    }

    .abg-toast-actions {
      display: flex;
      gap: 6px;
      flex-wrap: wrap;
      margin-top: 4px;
    }

    .abg-toast-btn {
      border: none;
      border-radius: 4px;
      padding: 5px 10px;
      font-size: 11px;
      font-weight: 500;
      cursor: pointer;
      white-space: nowrap;
      transition: background 0.15s;
    }

    .abg-toast-btn-allow {
      background: rgba(6, 182, 212, 0.2);
      color: #06b6d4;
      border: 1px solid rgba(6, 182, 212, 0.3);
    }
    .abg-toast-btn-allow:hover {
      background: rgba(6, 182, 212, 0.35);
    }

    .abg-toast-btn-whitelist {
      background: rgba(34, 197, 94, 0.18);
      color: #4ade80;
      border: 1px solid rgba(34, 197, 94, 0.3);
    }
    .abg-toast-btn-whitelist:hover {
      background: rgba(34, 197, 94, 0.3);
    }

    .abg-toast-btn-settings {
      background: rgba(255, 255, 255, 0.06);
      color: #ccc;
      border: 1px solid rgba(255, 255, 255, 0.12);
    }
    .abg-toast-btn-settings:hover {
      background: rgba(255, 255, 255, 0.12);
      color: #fff;
    }
  `;
}
