/**
 * Background service worker entry point.
 *
 * Central coordinator for the extension.
 */

import type { MessagePayload, DetectionEvent, KillSwitchEvent, AgentEvent, BoundaryViolation } from '../types/events';
import type { AgentIdentity } from '../types/agent';
import type { DelegationRule } from '../types/delegation';
import type { AgentSession } from '../session/types';
import { getStorageState, saveSession, updateSession, saveDelegationRules, appendDetectionLog, updateSettings, getLifetimeStats, updateLifetimeStats } from '../session/storage';
import type { LifetimeStats } from '../session/types';
import { DEFAULT_LIFETIME_STATS } from '../session/types';
import { createTimelineEvent, appendEventToSession } from '../session/timeline';
import { executeBackgroundKillSwitch, createInitialKillSwitchState } from '../killswitch/index';
import type { KillSwitchState } from '../killswitch/index';
import { isTimeBoundExpired } from '../delegation/rules';
import { setupNotificationHandlers, clearAllNotifications } from '../alerts/notification';
import type { BoundaryAlert } from '../alerts/boundary';
import { processBoundaryViolation, handleAllowOnce } from './handlers';
import { isValidSender } from './sender-validation';
import { computeBadge, BLOCK_BADGE_TTL_MS } from './badge';
import { monitorDebuggerAttachment } from '../detection/cdp-debugger';
import type { DebuggerDetectionResult } from '../detection/cdp-debugger';
import { lookupAgentIdentity } from '../aim/client';
import { lookupRegistryTrust } from '../registry/client';
import { generateSessionReport, storeReport, getReports } from '../session/report';
import { recordDetection, queueEvent, flushQueue, getConsent, getContributeStats } from '../contribute/client';
import { anonymizeDetection, anonymizeSession } from '../contribute/anonymize';
import { getAIMAuthState } from '../aim/auth';
import type { SessionReport } from '../session/report';
import type { NetworkEvent } from '../content/network-interceptor';

interface BackgroundState {
  activeAgents: Map<number, AgentIdentity>;
  activeSessions: Map<number, string>; // tabId -> sessionId
  delegationRules: DelegationRule[];
  killSwitch: KillSwitchState;
  recentAlerts: BoundaryAlert[];
  lifetimeStats: LifetimeStats;
  /**
   * Epoch ms of the most recent block. Drives the transient "!" icon badge
   * that surfaces a block to the user even if they missed the toast. Cleared
   * when the popup is opened or after BLOCK_BADGE_TTL_MS.
   */
  lastBlockAt: number | null;
}

const state: BackgroundState = {
  activeAgents: new Map(),
  activeSessions: new Map(),
  delegationRules: [],
  killSwitch: createInitialKillSwitchState(),
  recentAlerts: [],
  lifetimeStats: { ...DEFAULT_LIFETIME_STATS },
  lastBlockAt: null,
};

function initialize(): void {
  loadPersistedState().then(() => {
    updateBadge();
  }).catch((err) => {
    console.error('[AI Browser Guard] Failed to load state:', err);
  });

  // Message routing
  chrome.runtime.onMessage.addListener(handleMessage);

  // Tab lifecycle
  chrome.tabs.onRemoved.addListener((tabId) => {
    handleTabRemoved(tabId).catch(() => { /* ignore */ });
  });

  // Delegation expiration alarm
  chrome.alarms.create('delegation-check', { periodInMinutes: 1 });
  // Service worker keepalive — MV3 workers terminate after ~5 min idle
  chrome.alarms.create('keepalive-ping', { periodInMinutes: 0.4 });
  // Periodic flush of queued contribution events
  chrome.alarms.create('contribute-flush', { periodInMinutes: 5 });
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === 'delegation-check') {
      checkDelegationExpiration().catch(() => { /* ignore */ });
    }
    // keepalive-ping requires no action — the alarm firing is sufficient to keep the SW alive
    if (alarm.name === 'contribute-flush') {
      (async () => {
        const consent = await getConsent().catch(() => null);
        if (consent?.enabled) {
          const auth = await getAIMAuthState().catch(() => null);
          await flushQueue(auth?.accessToken).catch(() => { /* non-critical */ });
        }
      })().catch(() => { /* non-critical */ });
    }
  });

  // Kill switch keyboard shortcut
  registerKeyboardShortcut();

  // Notification handlers
  setupNotificationHandlers((notificationId) => {
    handleAllowOnce(notificationId).catch(() => { /* ignore */ });
  });

  // CDP debugger attachment monitor — detects Playwright, Puppeteer, etc.
  monitorDebuggerAttachment((result) => {
    handleCdpDebuggerDetection(result).catch((err) => {
      console.error('[AI Browser Guard] CDP detection handler error:', err);
    });
  }, 3000);

  console.debug('[AI Browser Guard] Background service worker initialized');
}

async function loadPersistedState(): Promise<void> {
  const stored = await getStorageState();
  state.delegationRules = stored.delegationRules;
  state.lifetimeStats = await getLifetimeStats();

  // Check for active sessions that may have survived a restart
  for (const session of stored.sessions) {
    if (!session.endedAt) {
      // Mark stale sessions as ended
      await updateSession(session.id, (s) => ({
        ...s,
        endedAt: new Date().toISOString(),
        endReason: 'agent-disconnected',
      }));
    }
  }
}

function handleMessage(
  message: MessagePayload,
  sender: chrome.runtime.MessageSender,
  sendResponse: (response: unknown) => void
): boolean {
  if (!message || !message.type) return false;

  if (!isValidSender(message.type, sender)) {
    // Silently drop. Don't surface which message types are popup-only vs
    // content-only — that would leak the validation map to a probe.
    return false;
  }

  const tabId = sender.tab?.id;

  switch (message.type) {
    case 'DETECTION_RESULT': {
      if (tabId !== undefined) {
        handleDetection(tabId, message.data as DetectionEvent).then(() => {
          sendResponse({ success: true });
        }).catch(() => {
          sendResponse({ success: false });
        });
        return true; // async response
      }
      return false;
    }

    case 'AGENT_ACTION': {
      if (tabId !== undefined) {
        handleAgentAction(tabId, message.data as AgentEvent);
      }
      sendResponse({ success: true });
      return false;
    }

    case 'BOUNDARY_CHECK_REQUEST': {
      const violation = message.data as BoundaryViolation;
      handleBoundaryViolation(tabId, violation);
      sendResponse({ success: true });
      return false;
    }

    case 'KILL_SWITCH_ACTIVATE': {
      executeKillSwitch(
        (message.data as { trigger?: string })?.trigger as 'button' | 'keyboard-shortcut' | 'api' ?? 'button'
      ).then((event) => {
        sendResponse({ success: true, event });
      }).catch(() => {
        sendResponse({ success: false });
      });
      return true; // async response
    }

    case 'KILL_SWITCH_RESET': {
      state.killSwitch.isActive = false;
      state.killSwitch.lastEvent = null;
      state.killSwitch.lastActivatedAt = null;
      updateBadge();
      // P1-2: broadcast the reset to every tab so each content script can
      // lift the MAIN-world hard-block sentinel. Without this, MAIN-world
      // wrappers would continue to deny every capability check after the
      // user resets the kill switch from the popup.
      chrome.tabs.query({}).then((tabs) => {
        for (const tab of tabs) {
          if (tab.id === undefined) continue;
          chrome.tabs.sendMessage(tab.id, {
            type: 'KILL_SWITCH_RESET',
            data: {},
            sentAt: new Date().toISOString(),
          }).catch(() => { /* tab may not have a content script */ });
        }
      }).catch(() => { /* best effort */ });
      sendResponse({ success: true });
      return false;
    }

    case 'DELEGATION_UPDATE': {
      const rule = message.data as DelegationRule;
      handleDelegationUpdate(rule).then(() => {
        sendResponse({ success: true });
      }).catch(() => {
        sendResponse({ success: false });
      });
      return true;
    }

    case 'SESSION_QUERY': {
      getStorageState().then((stored) => {
        sendResponse({ sessions: stored.sessions });
      }).catch(() => {
        sendResponse({ sessions: [] });
      });
      return true;
    }

    case 'STATUS_QUERY': {
      const agents = Array.from(state.activeAgents.values());
      const activeRule = state.delegationRules.find((r) => r.isActive) ?? null;
      sendResponse({
        detectedAgents: agents,
        activeDelegation: activeRule,
        killSwitchActive: state.killSwitch.isActive,
        recentViolations: state.recentAlerts,
        delegationRules: state.delegationRules,
        lifetimeStats: state.lifetimeStats,
      });
      // The popup is now open; the user has seen the block alert.
      // Clear the transient block badge so the icon returns to its
      // base state (agent count / delegation / idle).
      if (state.lastBlockAt !== null) {
        state.lastBlockAt = null;
        updateBadge();
      }
      return false;
    }

    case 'SETTINGS_UPDATE': {
      const updates = message.data as Record<string, unknown>;
      updateSettings(updates).then(() => {
        sendResponse({ success: true });
      }).catch(() => {
        sendResponse({ success: false });
      });
      return true;
    }

    case 'NETWORK_EVENT': {
      if (tabId !== undefined) {
        const networkEvent = message.data as NetworkEvent;
        const netSessionId = state.activeSessions.get(tabId);
        if (netSessionId) {
          updateSession(netSessionId, (session) => {
            const events = session.networkEvents ?? [];
            // Keep last 200 network events per session
            const updated = [...events, networkEvent];
            if (updated.length > 200) {
              updated.splice(0, updated.length - 200);
            }
            return { ...session, networkEvents: updated };
          }).catch(() => { /* non-critical */ });
        }
      }
      sendResponse({ success: true });
      return false;
    }

    case 'REPORTS_QUERY': {
      getReports().then((reports) => {
        sendResponse({ reports });
      }).catch(() => {
        sendResponse({ reports: [] });
      });
      return true;
    }

    case 'REPORT_EXPORT': {
      const { reportId } = message.data as { reportId: string };
      (async () => {
        const reports = await getReports();
        const report = reports.find((r) => r.id === reportId);
        if (report) {
          const { exportReportAsJSON } = await import('../session/report');
          sendResponse({ json: exportReportAsJSON(report) });
        } else {
          sendResponse({ json: null });
        }
      })().catch(() => {
        sendResponse({ json: null });
      });
      return true;
    }

    case 'CDP_DEBUGGER_CHECK': {
      // Content script is asking us to check for CDP debugger attachment.
      // This is used as a secondary detection path — the content script
      // detects stack trace anomalies, then asks the background to confirm
      // via the chrome.debugger API.
      (async () => {
        const { detectDebuggerAttachment } = await import('../detection/cdp-debugger');
        const result = await detectDebuggerAttachment();
        sendResponse({ detected: result.detected, result });
        if (result.detected && tabId !== undefined) {
          await handleCdpDebuggerDetection(result);
        }
      })().catch(() => {
        sendResponse({ detected: false });
      });
      return true; // async response
    }

    case 'CONTRIBUTE_STATS': {
      getContributeStats().then((stats) => {
        sendResponse(stats);
      }).catch(() => {
        sendResponse({ totalContributed: 0, queuedCount: 0, lastFlushedAt: null, enabled: false });
      });
      return true;
    }

    case 'CONTRIBUTE_ENABLE': {
      (async () => {
        const { enableContributions } = await import('../contribute/client');
        await enableContributions();
        sendResponse({ success: true });
      })().catch(() => {
        sendResponse({ success: false });
      });
      return true;
    }

    case 'CONTRIBUTE_DISABLE': {
      (async () => {
        const { disableContributions } = await import('../contribute/client');
        await disableContributions();
        sendResponse({ success: true });
      })().catch(() => {
        sendResponse({ success: false });
      });
      return true;
    }

    case 'CONTRIBUTE_FLUSH': {
      (async () => {
        const auth = await getAIMAuthState().catch(() => null);
        const result = await flushQueue(auth?.accessToken);
        sendResponse(result);
      })().catch(() => {
        sendResponse({ sent: 0, success: false });
      });
      return true;
    }

    case 'CONTRIBUTE_TIP_DISMISS': {
      (async () => {
        const { dismissTip } = await import('../contribute/client');
        await dismissTip();
        sendResponse({ success: true });
      })().catch(() => {
        sendResponse({ success: false });
      });
      return true;
    }

    case 'DOMAIN_WHITELIST': {
      const { domain } = message.data as { domain: string };
      handleDomainWhitelist(domain).then(() => {
        sendResponse({ success: true });
      }).catch(() => {
        sendResponse({ success: false });
      });
      return true;
    }

    case 'OPEN_POPUP': {
      // Sent from the content-side toast's "Settings" button. Sender
      // gate already requires sender.tab !== undefined AND
      // sender.frameId === 0 (main-frame only — toast only renders there;
      // sub-iframe origins are spam vectors). Tries the native
      // action.openPopup() first (Chrome 127+); falls back to opening
      // the popup HTML as a tab if the API is unavailable or rejects
      // (e.g., no active window).
      (async () => {
        const openPopup = (chrome.action as { openPopup?: () => Promise<void> }).openPopup;
        if (typeof openPopup === 'function') {
          try {
            await openPopup.call(chrome.action);
            sendResponse({ success: true, surface: 'popup' });
            return;
          } catch {
            // fall through to tab fallback
          }
        }
        try {
          await chrome.tabs.create({ url: chrome.runtime.getURL('dist/popup/index.html') });
          sendResponse({ success: true, surface: 'tab' });
        } catch {
          sendResponse({ success: false });
        }
      })();
      return true;
    }

    default:
      return false;
  }
}

async function handleDetection(tabId: number, event: DetectionEvent): Promise<void> {
  if (!event.agent) return;

  state.activeAgents.set(tabId, event.agent);

  // Create a new session
  const session: AgentSession = {
    id: crypto.randomUUID(),
    agent: event.agent,
    delegationRule: state.delegationRules.find((r) => r.isActive) ?? null,
    events: [],
    startedAt: new Date().toISOString(),
    endedAt: null,
    endReason: null,
    summary: {
      totalActions: 0,
      allowedActions: 0,
      blockedActions: 0,
      violations: 0,
      topUrls: [],
      durationSeconds: null,
    },
  };

  // Add detection event to timeline
  const agentDisplayNames: Record<string, string> = {
    playwright: 'Playwright',
    puppeteer: 'Puppeteer',
    selenium: 'Selenium',
    'anthropic-computer-use': 'Anthropic Computer Use',
    'openai-operator': 'OpenAI Operator',
    'cdp-generic': 'CDP Agent',
    'webdriver-generic': 'WebDriver Agent',
    unknown: 'Unknown Agent',
  };
  const agentDisplayName = agentDisplayNames[event.agent.type] ?? event.agent.type;
  const timelineEvent = createTimelineEvent('detection', event.url, `Agent detected: ${agentDisplayName}`, {
    outcome: 'informational',
  });
  const updatedSession = appendEventToSession(session, timelineEvent);

  await saveSession(updatedSession);
  state.activeSessions.set(tabId, updatedSession.id);

  // AIM + Registry trust lookup (non-blocking)
  enrichAgentTrust(tabId, event.agent).catch(() => { /* non-critical */ });

  // Log detection
  await appendDetectionLog(event);

  // Update lifetime stats
  const agentType = event.agent.type;
  const updatedTypes = { ...state.lifetimeStats.agentTypesDetected };
  updatedTypes[agentType] = (updatedTypes[agentType] ?? 0) + 1;
  state.lifetimeStats = {
    ...state.lifetimeStats,
    firstActiveAt: state.lifetimeStats.firstActiveAt ?? new Date().toISOString(),
    totalSessions: state.lifetimeStats.totalSessions + 1,
    agentTypesDetected: updatedTypes,
  };
  updateLifetimeStats(() => state.lifetimeStats).catch(() => { /* non-critical */ });

  // Record detection for consent tip tracking + contribute if enabled
  recordDetection().catch(() => { /* non-critical */ });
  const consent = await getConsent().catch(() => null);
  if (consent?.enabled) {
    const hadDelegation = state.delegationRules.some((r) => r.isActive);
    const contribution = anonymizeDetection(event, hadDelegation);
    queueEvent(contribution).catch(() => { /* non-critical */ });
  }

  updateBadge();
}

/**
 * Enrich an agent's identity with AIM and registry trust data.
 * Updates the agent in activeAgents and the stored session.
 */
async function enrichAgentTrust(tabId: number, agent: AgentIdentity): Promise<void> {
  const settings = (await getStorageState()).settings;
  let aimScore: number | null = null;
  let registryScore: number | null = null;

  // AIM lookup
  if (settings.aimLookupEnabled) {
    const aimResult = await lookupAgentIdentity(agent.type, agent.originUrl, {
      baseUrl: settings.aimBaseUrl,
    });
    if (aimResult.status === 'ok') {
      aimScore = aimResult.trustScore;
      agent.label = aimResult.label;
    } else if (aimResult.status === 'unregistered') {
      // Informational only — surface the label but do not feed an
      // unregistered=0 score into trust averaging.
      agent.label = aimResult.label;
    }
    // unreachable: no signal, leave aimScore null so it's excluded from averaging.
  }

  // Registry lookup
  if (settings.registryLookupEnabled) {
    const registryResult = await lookupRegistryTrust(agent.type, {
      baseUrl: settings.registryBaseUrl,
    });
    if (registryResult) {
      registryScore = registryResult.trustScore;
      if (!agent.label && registryResult.displayName) {
        agent.label = registryResult.displayName;
      }
    }
  }

  // Combine scores: average of available scores
  const scores = [aimScore, registryScore].filter((s): s is number => s !== null);
  if (scores.length > 0) {
    agent.trustScore = scores.reduce((a, b) => a + b, 0) / scores.length;
  }

  // Update the agent in state
  state.activeAgents.set(tabId, agent);

  // Update the session agent
  const sessionId = state.activeSessions.get(tabId);
  if (sessionId) {
    await updateSession(sessionId, (session) => ({
      ...session,
      agent: { ...agent },
    }));
  }
}

function handleAgentAction(tabId: number, event: AgentEvent): void {
  const sessionId = state.activeSessions.get(tabId);
  if (!sessionId) return;

  updateSession(sessionId, (session) => appendEventToSession(session, event)).catch(() => {
    // Ignore storage errors for individual events
  });
}

function handleBoundaryViolation(tabId: number | undefined, violation: BoundaryViolation): void {
  const activeRule = state.delegationRules.find((r) => r.isActive);
  if (!activeRule) return;

  // processBoundaryViolation creates the alert, shows the notification, stores the pending
  // override, and logs the timeline event.
  const alert = processBoundaryViolation(tabId, violation, activeRule, state.activeSessions);

  state.recentAlerts.push(alert);
  if (state.recentAlerts.length > 20) {
    state.recentAlerts.shift();
  }

  // Surface the block via the action-icon badge so the user knows
  // BrowserGuard intervened even if they missed the inline toast. The
  // badge auto-clears after BLOCK_BADGE_TTL_MS or on popup open.
  state.lastBlockAt = Date.now();
  updateBadge();
  setTimeout(() => {
    // Only redraw if the alert hasn't been re-armed in the meantime.
    if (
      state.lastBlockAt !== null
      && Date.now() - state.lastBlockAt >= BLOCK_BADGE_TTL_MS
    ) {
      state.lastBlockAt = null;
      updateBadge();
    }
  }, BLOCK_BADGE_TTL_MS + 50);

  // Update lifetime stats
  state.lifetimeStats = {
    ...state.lifetimeStats,
    totalActionsBlocked: state.lifetimeStats.totalActionsBlocked + 1,
  };
  updateLifetimeStats(() => state.lifetimeStats).catch(() => { /* non-critical */ });
}

async function handleDelegationUpdate(rule: DelegationRule): Promise<void> {
  // Add or update the new rule first, then deactivate all others (atomic swap — avoids brief gap with no active rule)
  const existingIndex = state.delegationRules.findIndex((r) => r.id === rule.id);
  if (existingIndex >= 0) {
    state.delegationRules[existingIndex] = rule;
  } else {
    state.delegationRules.push(rule);
  }

  // Deactivate all rules except the new one
  for (const r of state.delegationRules) {
    if (r.id !== rule.id) {
      r.isActive = false;
    }
  }

  await saveDelegationRules(state.delegationRules);

  // Broadcast to all content scripts
  const tabs = await chrome.tabs.query({});
  for (const tab of tabs) {
    if (tab.id === undefined) continue;
    try {
      await chrome.tabs.sendMessage(tab.id, {
        type: 'DELEGATION_UPDATE',
        data: rule,
        sentAt: new Date().toISOString(),
      });
    } catch {
      // Tab may not have content script
    }
  }

  updateBadge();
}

/**
 * Add a *.domain allow pattern to the active delegation rule.
 * Called when the user clicks "Allow on [domain]" in a blocked-action toast.
 */
async function handleDomainWhitelist(domain: string): Promise<void> {
  const activeRule = state.delegationRules.find((r) => r.isActive);
  if (!activeRule) return;

  const pattern = `*.${domain}`;

  // Avoid duplicates
  const exists = activeRule.scope.sitePatterns.some(
    (p) => p.pattern === pattern || p.pattern === domain
  );
  if (!exists) {
    activeRule.scope.sitePatterns.push({ pattern, action: 'allow' });
  }

  await saveDelegationRules(state.delegationRules);

  // Broadcast updated rule to all content scripts
  const tabs = await chrome.tabs.query({});
  for (const tab of tabs) {
    if (tab.id === undefined) continue;
    try {
      await chrome.tabs.sendMessage(tab.id, {
        type: 'DELEGATION_UPDATE',
        data: activeRule,
        sentAt: new Date().toISOString(),
      });
    } catch {
      // Tab may not have content script
    }
  }
}

async function executeKillSwitch(
  trigger: 'button' | 'keyboard-shortcut' | 'api'
): Promise<KillSwitchEvent> {
  const agentIds = Array.from(state.activeAgents.values()).map((a) => a.id);

  const event = await executeBackgroundKillSwitch(trigger, agentIds, []);

  state.killSwitch.isActive = true;
  state.killSwitch.lastEvent = event;
  state.killSwitch.lastActivatedAt = event.timestamp;

  // Clear active agents
  state.activeAgents.clear();

  // Deactivate all delegation rules
  for (const rule of state.delegationRules) {
    rule.isActive = false;
  }
  await saveDelegationRules(state.delegationRules);

  // End all active sessions and generate reports
  for (const [tabId, sessionId] of state.activeSessions.entries()) {
    await updateSession(sessionId, (session) => ({
      ...session,
      endedAt: new Date().toISOString(),
      endReason: 'kill-switch' as const,
    }));
    await generateAndStoreReport(sessionId);
    state.activeSessions.delete(tabId);
  }

  await clearAllNotifications();
  updateBadge();

  return event;
}

function updateBadge(): void {
  try {
    const badge = computeBadge(
      {
        lastBlockAt: state.lastBlockAt,
        killSwitchActive: state.killSwitch.isActive,
        agentCount: state.activeAgents.size,
        hasActiveDelegation: state.delegationRules.some((r) => r.isActive),
      },
      Date.now(),
    );
    chrome.action.setBadgeText({ text: badge.text });
    chrome.action.setBadgeBackgroundColor({ color: badge.color });
    return;
  } catch {
    // Badge API may not be available in all contexts
  }
}

/**
 * Handle CDP debugger attachment detected from the background monitor.
 *
 * When chrome.debugger.getTargets() finds targets with attached debuggers,
 * this creates detection events for the affected tabs and notifies their
 * content scripts.
 */
async function handleCdpDebuggerDetection(result: DebuggerDetectionResult): Promise<void> {
  // Create a detection event for each affected tab
  for (const target of result.targets) {
    const tabId = target.tabId;
    if (tabId === undefined) continue;

    // Skip if we already have an active agent for this tab
    if (state.activeAgents.has(tabId)) continue;

    const event: DetectionEvent = {
      id: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      methods: ['cdp-connection'],
      confidence: result.confidence,
      agent: {
        id: crypto.randomUUID(),
        type: result.inferredFramework,
        detectionMethods: ['cdp-connection'],
        confidence: result.confidence,
        detectedAt: new Date().toISOString(),
        originUrl: target.url,
        observedCapabilities: [],
        isActive: true,
      },
      url: target.url,
      signals: {
        debuggerAttached: true,
        targetType: target.type,
        inferredFramework: result.inferredFramework,
      },
    };

    await handleDetection(tabId, event);
  }
}

async function handleTabRemoved(tabId: number): Promise<void> {
  const sessionId = state.activeSessions.get(tabId);
  if (sessionId) {
    await updateSession(sessionId, (session) => ({
      ...session,
      endedAt: new Date().toISOString(),
      endReason: 'page-unload' as const,
    }));
    // Generate post-session report
    await generateAndStoreReport(sessionId);
    state.activeSessions.delete(tabId);
  }
  state.activeAgents.delete(tabId);
  updateBadge();
}

/**
 * Generate a report for a completed session and store it.
 */
async function generateAndStoreReport(sessionId: string): Promise<void> {
  try {
    const stored = await getStorageState();
    const session = stored.sessions.find((s) => s.id === sessionId);
    if (session && session.endedAt) {
      const report = generateSessionReport(session);
      await storeReport(report);

      // Contribute anonymized session summary if enabled
      const consent = await getConsent().catch(() => null);
      if (consent?.enabled && session) {
        const sessionContribution = anonymizeSession(session);
        queueEvent(sessionContribution).catch(() => { /* non-critical */ });
      }
    }
  } catch {
    // Report generation is non-critical
  }
}

async function checkDelegationExpiration(): Promise<void> {
  let changed = false;
  for (const rule of state.delegationRules) {
    if (rule.isActive && isTimeBoundExpired(rule.scope.timeBound)) {
      rule.isActive = false;
      changed = true;

      // Notify content scripts
      const tabs = await chrome.tabs.query({});
      for (const tab of tabs) {
        if (tab.id === undefined) continue;
        try {
          await chrome.tabs.sendMessage(tab.id, {
            type: 'DELEGATION_UPDATE',
            data: null,
            sentAt: new Date().toISOString(),
          });
        } catch {
          // Tab may not have content script
        }
      }
    }
  }

  if (changed) {
    await saveDelegationRules(state.delegationRules);
    updateBadge();
  }
}

function registerKeyboardShortcut(): void {
  try {
    chrome.commands.onCommand.addListener((command) => {
      if (command === 'kill-switch') {
        executeKillSwitch('keyboard-shortcut').catch(() => { /* ignore */ });
      }
    });
  } catch {
    // Commands API may not be available
  }
}

initialize();
