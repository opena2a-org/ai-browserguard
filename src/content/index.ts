/**
 * Content script entry point.
 *
 * Injected into every page at document_start. Initializes the detection
 * engine and boundary monitor, then relays results to the background
 * service worker.
 */

import type { MessagePayload, MessageType, BoundaryViolation } from '../types/events';
import { startDetectionMonitor } from './detector';
import type { DetectionVerdictResult } from './detector';
import { startBoundaryMonitor, updateActiveRule, getMonitorState, grantMonitorAllowOnce, clearMonitorAllowOnce } from './monitor';
import { executeContentKillSwitch, registerCleanup } from '../killswitch/index';
import type { DelegationRule } from '../types/delegation';
import { showBlockedToast } from './toast';
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

let detectionCleanup: (() => void) | null = null;
let monitorCleanup: (() => void) | null = null;
let currentAgentId: string | null = null;
let contextInvalidated = false;

/**
 * Private port to the MAIN-world interceptor. Held in closure; only this
 * module's code can read or write through it. After the bootstrap transfer,
 * `window` is no longer used to communicate with MAIN.
 */
let mainWorldPort: MessagePort | null = null;

/** Returns true when the extension context is still valid. */
function isContextValid(): boolean {
  try {
    return !contextInvalidated && !!chrome.runtime?.id;
  } catch {
    contextInvalidated = true;
    return false;
  }
}

/**
 * Send a message to the MAIN-world interceptor through the bridge port.
 * No-op if the bootstrap has not yet completed (early synthetic calls before
 * MAIN attaches its handler are dropped; production callers run well after
 * document_start so the port is always ready).
 */
function postToMainWorld(message: BridgeMessage): void {
  if (mainWorldPort) {
    mainWorldPort.postMessage(message);
  }
}

/**
 * Show an inline toast for a blocked action. Routes the three quick-action
 * callbacks back to the right surface: ALLOW_ONCE goes to the MAIN world
 * interceptor (via the private bridge port), DOMAIN_WHITELIST and OPEN_POPUP
 * go to the background.
 */
function showBlockedActionToast(capability: string, url: string, reason: string): void {
  showBlockedToast({
    capability,
    url,
    reason,
    onAllowOnce: () => {
      // Relay the one-shot allow to BOTH enforcement surfaces: the MAIN-world
      // interceptor (window.open / form.submit / DOM-write / network wrappers)
      // and the ISOLATED-world monitor, which issues the commonest in-page
      // block (synthetic click/type under Read-Only) and previously never saw
      // the grant — the button was inert exactly where users saw it (F-B).
      postToMainWorld({ type: MSG_ALLOW_ONCE, capability, url });
      grantMonitorAllowOnce(capability, url);
    },
    onWhitelist: (domain: string) => {
      sendToBackground('DOMAIN_WHITELIST', { domain }).catch(() => { /* ignore */ });
    },
    onOpenSettings: () => {
      sendToBackground('OPEN_POPUP', {}).catch(() => { /* ignore */ });
    },
  });
}

/** Send the current delegation rule to the MAIN world interceptor. */
function syncRuleToMainWorld(rule: DelegationRule | null): void {
  const ruleData = rule
    ? {
        isActive: rule.isActive,
        expiresAt: rule.scope.timeBound?.expiresAt ?? null,
        actionRestrictions: rule.scope.actionRestrictions.map((r) => ({
          capability: r.capability,
          action: r.action,
        })),
        sitePatterns: rule.scope.sitePatterns.map((p) => ({
          pattern: p.pattern,
          action: p.action,
        })),
      }
    : null;
  postToMainWorld({ type: MSG_RULE_UPDATE, rule: ruleData });
}

/**
 * Handle messages received from the MAIN-world interceptor via the bridge port.
 *
 * Validates each field shape before forwarding to background. The port itself
 * is a trust boundary, but if an attacker ever wins the bootstrap race (the
 * known residual risk of the document_start ordering defense), field-level
 * validation prevents forged messages from reaching downstream consumers with
 * arbitrary payloads.
 */
function handleMainWorldMessage(e: MessageEvent): void {
  const data = e.data as BridgeMessage | undefined;
  if (!data || typeof data.type !== 'string') return;

  // Handle CDP automation detection from the MAIN world stack trace trap
  if (data.type === MSG_CDP_DETECTED) {
    const framework = typeof data.framework === 'string' ? data.framework : '';
    const detail = typeof data.detail === 'string' ? data.detail : '';
    const signals = (data.signals && typeof data.signals === 'object')
      ? (data.signals as Record<string, unknown>)
      : {};
    const timestamp = typeof data.timestamp === 'string' ? data.timestamp : new Date().toISOString();
    if (!framework) return;

    const agentTypeMap: Record<string, import('../types/agent').AgentType> = {
      playwright: 'playwright',
      puppeteer: 'puppeteer',
      selenium: 'selenium',
      'anthropic-computer-use': 'anthropic-computer-use',
      'openai-operator': 'openai-operator',
    };
    const agentType = agentTypeMap[framework] ?? 'cdp-generic';

    const agent: import('../types/agent').AgentIdentity = {
      id: crypto.randomUUID(),
      type: agentType,
      detectionMethods: ['framework-fingerprint'],
      confidence: 'confirmed',
      detectedAt: timestamp,
      originUrl: window.location.href,
      observedCapabilities: [],
      isActive: true,
    };

    currentAgentId = agent.id;

    const event: import('../types/events').DetectionEvent = {
      id: crypto.randomUUID(),
      timestamp,
      methods: ['framework-fingerprint'],
      confidence: 'confirmed',
      agent,
      url: window.location.href,
      signals: { ...signals, source: 'stack-trace-trap', detail },
    };

    sendToBackground('DETECTION_RESULT', event).catch(() => { /* ignore */ });
    return;
  }

  // Relay network events from the MAIN world interceptor to background
  if (data.type === MSG_NETWORK_EVENT) {
    if (!data.event || typeof data.event !== 'object') return;
    sendToBackground('NETWORK_EVENT', data.event).catch(() => { /* ignore */ });
    return;
  }

  if (data.type !== MSG_ACTION) return;

  const capability = typeof data.capability === 'string' ? data.capability : null;
  const url = typeof data.url === 'string' ? data.url : null;
  const blocked = typeof data.blocked === 'boolean' ? data.blocked : null;
  const reason = typeof data.reason === 'string' ? data.reason : '';
  const timestamp = typeof data.timestamp === 'string' ? data.timestamp : new Date().toISOString();
  if (!capability || !url || blocked === null) return;

  if (blocked) {
    const violation: BoundaryViolation = {
      id: crypto.randomUUID(),
      timestamp,
      agentId: currentAgentId ?? '',
      attemptedAction: capability as BoundaryViolation['attemptedAction'],
      url,
      targetSelector: undefined,
      blockingRuleId: getMonitorState().activeRule?.id ?? 'none',
      reason,
      userOverride: false,
    };
    sendToBackground('BOUNDARY_CHECK_REQUEST', violation).catch(() => { /* ignore */ });
    showBlockedActionToast(capability, url, reason);
  }
}

/**
 * Set up the MAIN-world bridge. Creates a `MessageChannel`, transfers `port2`
 * to the MAIN-world interceptor via a one-shot `window.postMessage`, then
 * holds `port1` privately in this module's closure. All subsequent ISOLATED↔
 * MAIN traffic flows through the port.
 *
 * SECURITY: drops the `nonce`-on-`window.postMessage` design. A page that
 * registered `window.addEventListener('message', ...)` before our bundle
 * parsed could read every nonce off the wire and forge messages with it.
 * Port traffic is not visible to any other `window` listener.
 *
 * TIMING: relies on `manifest.json` content-script declaration ordering.
 * ISOLATED is declared first and runs first, queueing the bootstrap as a
 * post-message task. MAIN loads next and registers its one-shot bootstrap
 * listener synchronously. The task then dispatches. No page script can
 * register a `'message'` listener before this exchange because page parsing
 * has not advanced past document_start.
 */
function installMainWorldBridge(): void {
  const channel = new MessageChannel();
  mainWorldPort = channel.port1;
  mainWorldPort.onmessage = handleMainWorldMessage;
  mainWorldPort.start();

  // Target self-origin so that mid-stream cross-origin navigation cannot
  // accidentally deliver the bootstrap to a different document. `port2` is
  // transferred — the local handle is detached and the receiving realm gets
  // the entangled endpoint.
  window.postMessage(
    { type: MSG_BRIDGE_BOOTSTRAP },
    window.location.origin,
    [channel.port2],
  );
}

function initialize(): void {
  installMainWorldBridge();

  // Set up message listener for background communication
  chrome.runtime.onMessage.addListener(handleMessage);

  const startMonitoring = () => {
    // Start detection monitor
    detectionCleanup = startDetectionMonitor({}, onDetectionResult);
    registerCleanup(() => {
      if (detectionCleanup) detectionCleanup();
    });

    // Start boundary monitor (no rule initially = fail-closed)
    monitorCleanup = startBoundaryMonitor(
      null,
      (violation) => {
        sendToBackground('BOUNDARY_CHECK_REQUEST', violation).catch(() => { /* context gone */ });
        showBlockedActionToast(violation.attemptedAction, violation.url, violation.reason);
      },
      (event) => {
        sendToBackground('AGENT_ACTION', event).catch(() => { /* context gone */ });
      }
    );
    registerCleanup(() => {
      if (monitorCleanup) monitorCleanup();
    });

    // Request active delegation rules from background. The STATUS_QUERY
    // response also carries the current killSwitchActive state — when the
    // page navigates while the kill switch is active, content scripts
    // re-inject and need to re-arm the MAIN-world hard-block sentinel.
    // Without this, navigation would silently bypass the kill switch.
    sendToBackground('STATUS_QUERY', {}).then((response) => {
      if (response && typeof response === 'object') {
        const data = response as {
          activeDelegation?: DelegationRule;
          killSwitchActive?: boolean;
        };
        if (data.activeDelegation) {
          updateActiveRule(data.activeDelegation);
          syncRuleToMainWorld(data.activeDelegation);
        }
        if (data.killSwitchActive === true) {
          postToMainWorld({ type: MSG_KILL_SWITCH, active: true });
        }
      }
    }).catch(() => {
      // Background may not be ready
    });
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', startMonitoring, { once: true });
  } else {
    startMonitoring();
  }

  console.debug('[AI Browser Guard] Content script initialized');
}

async function sendToBackground(type: MessageType, data: unknown): Promise<unknown> {
  // Guard against "Extension context invalidated" — happens when the extension
  // reloads/updates but this content script is still alive in an old tab.
  if (!isContextValid()) {
    return undefined;
  }

  const message: MessagePayload = {
    type,
    data,
    sentAt: new Date().toISOString(),
  };

  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage(message, (response) => {
        if (chrome.runtime.lastError) {
          // Context invalidated between the check and the callback — resolve
          // instead of rejecting so callers never see unhandled rejections.
          contextInvalidated = true;
          resolve(undefined);
        } else {
          resolve(response);
        }
      });
    } catch {
      // Extension context invalidated — silently ignore
      contextInvalidated = true;
      resolve(undefined);
    }
  });
}

function handleMessage(
  message: MessagePayload,
  sender: chrome.runtime.MessageSender,
  sendResponse: (response: unknown) => void
): boolean {
  if (!isContextValid() || !message || !message.type) return false;
  // Defense-in-depth mirror of the background's sender validation: only this
  // extension may drive the content script (grants, kill-switch signals,
  // delegation updates). Today nothing external can reach this listener (no
  // externally_connectable), but a future manifest change must not silently
  // open a forgery path for ALLOW_ONCE or KILL_SWITCH_RESET.
  if (sender.id !== chrome.runtime.id) return false;

  switch (message.type) {
    case 'DELEGATION_UPDATE': {
      const rule = message.data as DelegationRule | null;
      updateActiveRule(rule);
      syncRuleToMainWorld(rule);

      // Restart monitor with new rule
      if (monitorCleanup) monitorCleanup();
      monitorCleanup = startBoundaryMonitor(
        rule,
        (violation) => {
          sendToBackground('BOUNDARY_CHECK_REQUEST', violation).catch(() => { /* context gone */ });
          showBlockedActionToast(violation.attemptedAction, violation.url, violation.reason);
        },
        (event) => sendToBackground('AGENT_ACTION', event).catch(() => { /* context gone */ })
      );
      sendResponse({ success: true });
      return false;
    }

    case 'KILL_SWITCH_ACTIVATE': {
      // P1-2: send the hard-block sentinel to MAIN BEFORE tearing down the
      // monitors. The wrappers in MAIN cannot be safely unwrapped (page
      // code may have captured references), so we flip a flag that makes
      // every isActionAllowed call return blocked. This is synchronous on
      // the JS event loop, narrowing the in-flight-action race window from
      // "executeKillSwitch's whole async chain" to "one microtask delivery
      // over the bridge port."
      postToMainWorld({ type: MSG_KILL_SWITCH, active: true });
      // Purge pending monitor-path allow-once grants, mirroring MAIN's
      // allowedOnce.clear(): a grant issued before the emergency must not
      // survive into a monitor re-armed while the switch is active.
      clearMonitorAllowOnce();
      // Stop all monitoring and clean up
      const result = executeContentKillSwitch();
      detectionCleanup = null;
      monitorCleanup = null;
      currentAgentId = null;
      sendResponse({ success: true, ...result });
      return false;
    }

    case 'KILL_SWITCH_RESET': {
      // P1-2: lift the hard-block in MAIN. The activeRule and allowedOnce
      // state in MAIN are independent of this flag — clearing the sentinel
      // restores normal rule processing without losing the previously
      // installed delegation rule.
      postToMainWorld({ type: MSG_KILL_SWITCH, active: false });
      sendResponse({ success: true });
      return false;
    }

    case 'STATUS_QUERY': {
      const state = getMonitorState();
      sendResponse({
        agentDetected: currentAgentId !== null,
        agentId: currentAgentId,
        monitorState: state,
      });
      return false;
    }

    case 'ALLOW_ONCE': {
      const { capability, url } = message.data as { capability: string; url: string };
      // Relay the allow-once signal to the MAIN world interceptor via the
      // private bridge port (no longer visible to other window listeners),
      // AND to the ISOLATED-world monitor so monitor-path blocks honor the
      // grant too (F-B).
      postToMainWorld({ type: MSG_ALLOW_ONCE, capability, url });
      grantMonitorAllowOnce(capability, url);
      sendResponse({ success: true });
      return false;
    }

    default:
      return false;
  }
}

function onDetectionResult(verdict: DetectionVerdictResult): void {
  if (verdict.agentDetected && verdict.agent) {
    currentAgentId = verdict.agent.id;
    sendToBackground('DETECTION_RESULT', verdict.event).catch(() => {
      // Background may not be available
    });
  }
}

initialize();
