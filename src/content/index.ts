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
import { startBoundaryMonitor, updateActiveRule, getMonitorState } from './monitor';
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
      // Relay the one-shot allow directly to the MAIN world interceptor.
      // Same payload shape as the chrome.notifications "Allow once" button
      // already wired through background/handlers.ts handleAllowOnce.
      postToMainWorld({ type: MSG_ALLOW_ONCE, capability, url });
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

/** Handle messages received from the MAIN-world interceptor via the bridge port. */
function handleMainWorldMessage(e: MessageEvent): void {
  const data = e.data as BridgeMessage | undefined;
  if (!data || typeof data.type !== 'string') return;

  // Handle CDP automation detection from the MAIN world stack trace trap
  if (data.type === MSG_CDP_DETECTED) {
    // The MAIN world interceptor detected automation via stack trace analysis.
    // Create a detection event and forward it to the background.
    const { framework, detail, signals, timestamp } = data as unknown as {
      framework: string;
      detail: string;
      signals: Record<string, unknown>;
      timestamp: string;
    };

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
      detectedAt: timestamp ?? new Date().toISOString(),
      originUrl: window.location.href,
      observedCapabilities: [],
      isActive: true,
    };

    currentAgentId = agent.id;

    const event: import('../types/events').DetectionEvent = {
      id: crypto.randomUUID(),
      timestamp: timestamp ?? new Date().toISOString(),
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
    sendToBackground('NETWORK_EVENT', data.event).catch(() => { /* ignore */ });
    return;
  }

  if (data.type !== MSG_ACTION) return;

  const { capability, url, blocked, reason, timestamp } = data as unknown as {
    capability: string;
    url: string;
    blocked: boolean;
    reason: string;
    timestamp: string;
  };

  if (blocked) {
    const violation: BoundaryViolation = {
      id: crypto.randomUUID(),
      timestamp: timestamp ?? new Date().toISOString(),
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

    // Request active delegation rules from background
    sendToBackground('STATUS_QUERY', {}).then((response) => {
      if (response && typeof response === 'object') {
        const data = response as { activeDelegation?: DelegationRule };
        if (data.activeDelegation) {
          updateActiveRule(data.activeDelegation);
          syncRuleToMainWorld(data.activeDelegation);
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
  _sender: chrome.runtime.MessageSender,
  sendResponse: (response: unknown) => void
): boolean {
  if (!isContextValid() || !message || !message.type) return false;

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
      // Stop all monitoring and clean up
      const result = executeContentKillSwitch();
      detectionCleanup = null;
      monitorCleanup = null;
      currentAgentId = null;
      sendResponse({ success: true, ...result });
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
      // private bridge port (no longer visible to other window listeners).
      postToMainWorld({ type: MSG_ALLOW_ONCE, capability, url });
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
