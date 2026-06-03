/**
 * CDP Debugger Attachment Detection.
 *
 * Uses the chrome.debugger API to detect when an external automation
 * framework (Playwright, Puppeteer, or any CDP client) is connected
 * to browser targets.
 *
 * This is the most reliable detection method because ALL modern
 * automation frameworks (Playwright, Puppeteer, Selenium 4+,
 * Anthropic Computer Use, OpenAI Operator) communicate with the
 * browser via Chrome DevTools Protocol. The chrome.debugger API
 * can detect these connections at the browser level, regardless
 * of what the page-level JavaScript context shows.
 *
 * Requires the "debugger" permission in manifest.json.
 */

import type { AgentType, DetectionConfidence, DetectionMethod } from '../types/agent';

export interface DebuggerDetectionResult {
  detected: boolean;
  method: DetectionMethod;
  confidence: DetectionConfidence;
  detail: string;
  targets: DebuggerTarget[];
  inferredFramework: AgentType;
}

export interface DebuggerTarget {
  targetId: string;
  type: string;
  title: string;
  url: string;
  attached: boolean;
  tabId?: number;
}

/**
 * Return true for targets that belong to the browser itself or to this
 * extension, rather than to navigable web content an external agent would
 * drive. These must never raise an agent verdict:
 *   - chrome:// / chrome-untrusted:// — browser UI (chrome://extensions, etc.)
 *   - devtools:// — the built-in DevTools front end
 *   - chrome-extension://<own-id>/ — this extension's own popup / pages / SW
 */
function isInternalUrl(url: string, ownExtensionId: string | undefined): boolean {
  if (!url) return false;
  // Note: about:blank is intentionally NOT excluded — automation frameworks
  // (Playwright/Puppeteer) routinely start on and drive about:blank, so it is
  // navigable content, not browser chrome.
  if (
    url.startsWith('chrome://') ||
    url.startsWith('chrome-untrusted://') ||
    url.startsWith('devtools://')
  ) {
    return true;
  }
  if (ownExtensionId && url.startsWith(`chrome-extension://${ownExtensionId}/`)) {
    return true;
  }
  return false;
}

/**
 * Detect whether the built-in DevTools front end is open anywhere in the
 * browser. When a user presses F12, the inspected page target reports
 * `attached === true` exactly as it would under an external CDP client, but a
 * devtools:// front-end target also appears in the target list. Its presence
 * means a page-level attachment is most likely the user's own DevTools, not an
 * automation framework, so such attachments are capped below `confirmed`.
 */
function builtInDevToolsPresent(allTargets: chrome.debugger.TargetInfo[]): boolean {
  return allTargets.some(
    (t) =>
      t.url?.startsWith('devtools://') ||
      (t.type === 'other' && (t.url?.includes('devtools') ?? false)),
  );
}

/**
 * Check all browser targets for attached debuggers.
 *
 * When a CDP client (Playwright, Puppeteer, etc.) connects to Chrome,
 * it attaches to one or more targets. This function queries the browser
 * for all targets and identifies those with active debugger attachments.
 *
 * Must be called from the background service worker (chrome.debugger is
 * not available in content scripts).
 */
export async function detectDebuggerAttachment(): Promise<DebuggerDetectionResult> {
  const noDetection: DebuggerDetectionResult = {
    detected: false,
    method: 'cdp-connection',
    confidence: 'low',
    detail: 'No external debugger attachment detected.',
    targets: [],
    inferredFramework: 'unknown',
  };

  // chrome.debugger may not be available if permission is missing
  if (typeof chrome === 'undefined' || !chrome.debugger || !chrome.debugger.getTargets) {
    return {
      ...noDetection,
      detail: 'chrome.debugger API not available (missing debugger permission).',
    };
  }

  try {
    const targets = await new Promise<chrome.debugger.TargetInfo[]>((resolve, reject) => {
      chrome.debugger.getTargets((result) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
        } else {
          resolve(result);
        }
      });
    });

    const ownExtensionId = typeof chrome.runtime?.id === 'string' ? chrome.runtime.id : undefined;

    // Find targets with an attached debugger, excluding browser-chrome,
    // DevTools, and this extension's own pages. Attachments on those are not
    // agents — they are the user's own browser surfaces (the source of the
    // observed false positives at chrome://extensions/ and the popup URL).
    const attachedTargets = targets.filter(
      (t) => t.attached && !isInternalUrl(t.url, ownExtensionId),
    );

    if (attachedTargets.length === 0) {
      return noDetection;
    }

    // Map to our target format
    const detectedTargets: DebuggerTarget[] = attachedTargets.map((t) => ({
      targetId: t.id,
      type: t.type,
      title: t.title,
      url: t.url,
      attached: t.attached,
      tabId: t.tabId,
    }));

    // Infer framework from target characteristics
    const framework = inferFrameworkFromTargets(attachedTargets);

    // Confidence is reserved for signals that an external CDP client — not the
    // user — is driving the browser:
    //   - browser-target attachment is exclusive to external clients
    //     (Puppeteer/Selenium connect to it); the built-in DevTools never does.
    //   - a vendor-specific stack signature (playwright/puppeteer in the
    //     target URL or title) is high-specificity.
    // A bare page-level attachment with the built-in DevTools front end open is
    // most likely F12, so it is capped at `medium`.
    const browserTargetAttached = attachedTargets.some((t) => t.type === 'browser');
    const hasVendorSignature = framework === 'playwright' || framework === 'puppeteer';
    const devToolsOpen = builtInDevToolsPresent(targets);

    let confidence: DetectionConfidence;
    if (browserTargetAttached || hasVendorSignature) {
      confidence = 'confirmed';
    } else if (devToolsOpen) {
      confidence = 'medium';
    } else {
      confidence = 'high';
    }

    const devToolsNote =
      confidence === 'medium'
        ? ' Built-in DevTools is open; this may be a manual inspection rather than an automation framework.'
        : '';

    return {
      detected: true,
      method: 'cdp-connection',
      confidence,
      detail: `External debugger attached to ${attachedTargets.length} target(s). Framework: ${framework}.${devToolsNote}`,
      targets: detectedTargets,
      inferredFramework: framework,
    };
  } catch (err) {
    return {
      ...noDetection,
      detail: `Failed to query debugger targets: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/**
 * Infer which automation framework is connected.
 *
 * Connection topology (page-only vs. browser-target) is NOT a reliable framework
 * fingerprint — Playwright, Puppeteer, Selenium, and hand-rolled CDP clients all
 * vary their attachment pattern by version and launch mode. Reporting a specific
 * vendor from topology alone produces confident-but-wrong labels (e.g. raw CDP
 * mislabeled "Playwright"). We therefore only name a vendor when a high-specificity
 * signature is present in a target URL or title, and otherwise report `cdp-generic`.
 */
function inferFrameworkFromTargets(attachedTargets: chrome.debugger.TargetInfo[]): AgentType {
  const haystack = attachedTargets
    .map((t) => `${t.url ?? ''} ${t.title ?? ''}`)
    .join(' ')
    .toLowerCase();

  if (haystack.includes('playwright')) {
    return 'playwright';
  }
  if (haystack.includes('puppeteer')) {
    return 'puppeteer';
  }

  return 'cdp-generic';
}

/**
 * Start monitoring for debugger attachments.
 *
 * Polls chrome.debugger.getTargets() at the specified interval and
 * invokes the callback when a new attachment is detected.
 *
 * Must be called from the background service worker.
 *
 * @returns Cleanup function to stop monitoring.
 */
export function monitorDebuggerAttachment(
  callback: (result: DebuggerDetectionResult) => void,
  intervalMs = 3000,
): () => void {
  let stopped = false;
  let lastDetectedCount = 0;

  const check = async () => {
    if (stopped) return;
    const result = await detectDebuggerAttachment();

    if (result.detected && result.targets.length !== lastDetectedCount) {
      lastDetectedCount = result.targets.length;
      callback(result);
    } else if (!result.detected) {
      lastDetectedCount = 0;
    }
  };

  // Initial check
  check().catch(() => { /* ignore */ });

  const intervalId = setInterval(() => {
    check().catch(() => { /* ignore */ });
  }, intervalMs);

  return () => {
    stopped = true;
    clearInterval(intervalId);
  };
}
