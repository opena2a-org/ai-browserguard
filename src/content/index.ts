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

const GUARD_NONCE = crypto.randomUUID();
const MSG_INIT = 'AI_GUARD:INIT';
const MSG_RULE_UPDATE = 'AI_GUARD:RULE_UPDATE';
const MSG_ACTION = 'AI_GUARD:ACTION';
const MSG_ALLOW_ONCE = 'AI_GUARD:ALLOW_ONCE';
const MSG_CDP_DETECTED = 'AI_GUARD:CDP_DETECTED';
const MSG_NETWORK_EVENT = 'AI_GUARD:NETWORK_EVENT';

let detectionCleanup: (() => void) | null = null;
let monitorCleanup: (() => void) | null = null;
let currentAgentId: string | null = null;
let contextInvalidated = false;

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
 * Show an inline toast for a blocked action. Routes the three quick-action
 * callbacks back to the right surface: ALLOW_ONCE goes to the MAIN world
 * interceptor (which already understands the message), DOMAIN_WHITELIST and
 * OPEN_POPUP go to the background.
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
      window.postMessage(
        { type: MSG_ALLOW_ONCE, nonce: GUARD_NONCE, capability, url },
        '*',
      );
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
  window.postMessage({ type: MSG_RULE_UPDATE, nonce: GUARD_NONCE, rule: ruleData }, '*');
}

function initialize(): void {
  // Introduce ourselves to the MAIN world interceptor with our nonce
  window.postMessage({ type: MSG_INIT, nonce: GUARD_NONCE }, '*');

  // Receive action reports and CDP detection from the MAIN world interceptor
  window.addEventListener('message', (e: MessageEvent) => {
    if (e.source !== window || !e.data) return;

    // Handle CDP automation detection from the MAIN world stack trace trap
    if (e.data.type === MSG_CDP_DETECTED) {
      // The MAIN world interceptor detected automation via stack trace analysis.
      // Create a detection event and forward it to the background.
      const { framework, detail, signals, timestamp } = e.data as {
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
    if (e.data.type === MSG_NETWORK_EVENT) {
      if (!e.data.nonce || e.data.nonce !== GUARD_NONCE) return;
      sendToBackground('NETWORK_EVENT', e.data.event).catch(() => { /* ignore */ });
      return;
    }

    if (e.data.type !== MSG_ACTION) return;
    if (!e.data.nonce || e.data.nonce !== GUARD_NONCE) return;

    const { capability, url, blocked, reason, timestamp } = e.data as {
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
  });

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
      // Relay the allow-once signal to the MAIN world interceptor via postMessage.
      window.postMessage(
        { type: MSG_ALLOW_ONCE, nonce: GUARD_NONCE, capability, url },
        '*'
      );
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
