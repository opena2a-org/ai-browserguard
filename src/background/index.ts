/**
 * Background service worker entry point.
 *
 * Central coordinator for the extension.
 */

import type { MessagePayload, DetectionEvent, KillSwitchEvent, AgentEvent, BoundaryViolation } from '../types/events';
import type { AgentIdentity } from '../types/agent';
import type { DelegationRule } from '../types/delegation';
import type { AgentSession } from '../session/types';
import { getStorageState, saveSession, updateSession, saveDelegationRules, appendDetectionLog, updateSettings, getSettings, getLifetimeStats, updateLifetimeStats, getKillSwitchState, saveKillSwitchState } from '../session/storage';
import type { LifetimeStats } from '../session/types';
import { DEFAULT_LIFETIME_STATS } from '../session/types';
import { createTimelineEvent, appendEventToSession } from '../session/timeline';
import { executeBackgroundKillSwitch, createInitialKillSwitchState } from '../killswitch/index';
import type { KillSwitchState } from '../killswitch/index';
import { isTimeBoundExpired, evaluateRule } from '../delegation/rules';
import { selectEffectiveRule, applyDelegationUpdate } from '../delegation/effective';
import { shouldIgnoreDownload, attributeDownload, describeDownload } from './download-monitor';
import { setupNotificationHandlers, clearAllNotifications } from '../alerts/notification';
import type { BoundaryAlert } from '../alerts/boundary';
import { processBoundaryViolation, handleAllowOnce } from './handlers';
import { isValidSender } from './sender-validation';
import { computeBadge, BLOCK_BADGE_TTL_MS } from './badge';
import { monitorDebuggerAttachment, detectDebuggerAttachment } from '../detection/cdp-debugger';
import type { DebuggerDetectionResult } from '../detection/cdp-debugger';
import {
  initCdpEnforcement,
  reconcileTabs,
  detachTab,
  shouldEnforceTab,
} from './cdp-enforcement';
import { lookupAgentIdentity } from '../aim/client';
import { lookupRegistryTrust } from '../registry/client';
import { lookupAiSafetyDeclaration, declarationOriginFor } from '../aisafety/client';
import { clearAiSafetyCache } from '../aisafety/cache';
import { collectAiSafetyDeclarations } from '../aisafety/attribution';
import type { StoredDeclaration } from '../aisafety/attribution';
import { generateSessionReport, storeReport, getReports } from '../session/report';
import { recordDetection, queueEvent, flushQueue, getConsent, getContributeStats } from '../contribute/client';
import { anonymizeDetection, anonymizeSession } from '../contribute/anonymize';
import type { SessionReport } from '../session/report';
import type { NetworkEvent } from '../content/network-interceptor';
import { buildReportDownloadArgs } from './report-download';
import { endStoredSessionsForKillSwitch } from './kill-switch-sessions';

interface BackgroundState {
  activeAgents: Map<number, AgentIdentity>;
  activeSessions: Map<number, string>; // tabId -> sessionId
  delegationRules: DelegationRule[];
  killSwitch: KillSwitchState;
  recentAlerts: BoundaryAlert[];
  lifetimeStats: LifetimeStats;
  /** Cached copy of settings.notificationsEnabled (refreshed on SETTINGS_UPDATE). */
  notificationsEnabled: boolean;
  /** Cached copy of settings.cdpEnforcementEnabled (refreshed on SETTINGS_UPDATE). */
  cdpEnforcementEnabled: boolean;
  /**
   * ai-safety.txt lookup result for the page each detected agent is operating
   * on, keyed by tabId so it shares `activeAgents`' lifecycle and is pruned by
   * the same tab-removal path. Display-only (ADR-009). Populated only when
   * `aiSafetyTxtEnabled` is on.
   *
   * The `origin` the result was fetched from is stored WITH it, and readers must
   * confirm it still matches the agent's current origin before showing it. A
   * tabId alone is not a safe key: there is no navigation listener in this
   * extension, so a tab keeps its id across a navigation to a different site.
   * Detection re-fires and swaps `activeAgents` synchronously while the new
   * lookup is still in flight, which would otherwise leave one site's safety
   * claims rendered on a card for an agent now operating on another site.
   */
  aiSafetyDeclarations: Map<number, StoredDeclaration>;
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
  notificationsEnabled: true,
  cdpEnforcementEnabled: false,
  aiSafetyDeclarations: new Map(),
  lastBlockAt: null,
};

/**
 * Recompute which tabs warrant CDP-layer network enforcement and converge the
 * attached debugger sessions to match. The desired set is empty whenever the
 * feature is off, so toggling it off (or a kill switch clearing agents) detaches
 * everything. Safe to call often; reconcileTabs no-ops when already converged.
 */
async function reconcileCdpEnforcement(): Promise<void> {
  const desired = new Set<number>();
  if (state.cdpEnforcementEnabled) {
    for (const tabId of state.activeAgents.keys()) {
      if (
        shouldEnforceTab({
          settingEnabled: true,
          hasAgent: true,
          rule: getEffectiveRuleForTab(tabId),
        })
      ) {
        desired.add(tabId);
      }
    }
  }
  await reconcileTabs(desired);
}

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
  // Service worker keepalive — MV3 workers are torn down after ~30s idle.
  // The alarm fires often enough to wake the worker before long idle gaps.
  chrome.alarms.create('keepalive-ping', { periodInMinutes: 0.4 });
  // Periodic flush of queued contribution events
  chrome.alarms.create('contribute-flush', { periodInMinutes: 5 });
  // CDP attachment self-wake. The in-session setInterval poll below dies with
  // the service worker and cannot restart itself, so an alarm tick re-runs the
  // check after every idle teardown, closing the gap where CDP-attached
  // automation would otherwise go undetected. (Chrome clamps the alarm period
  // to a 1-minute floor; the interval covers sub-minute latency while alive.)
  chrome.alarms.create('cdp-monitor', { periodInMinutes: 0.5 });
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === 'delegation-check') {
      checkDelegationExpiration().catch(() => { /* ignore */ });
    }
    if (alarm.name === 'cdp-monitor') {
      runCdpDebuggerCheck().catch(() => { /* ignore */ });
      // Self-heal CDP enforcement after a service-worker teardown dropped the
      // debugger sessions: re-attach tabs still under active delegation, detach
      // any that no longer qualify.
      reconcileCdpEnforcement().catch(() => { /* ignore */ });
    }
    // keepalive-ping requires no action — the alarm firing is sufficient to keep the SW alive
    if (alarm.name === 'contribute-flush') {
      (async () => {
        const consent = await getConsent().catch(() => null);
        if (consent?.enabled) {
          await flushQueue().catch(() => { /* non-critical */ });
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

  // Monitor agent-initiated downloads (exfiltration / drive-by vector). Only
  // downloads that occur while an agent is active are treated as agent
  // activity; the user's own downloads are never flagged.
  try {
    chrome.downloads.onCreated.addListener((item) => {
      handleDownloadCreated(item).catch((err) => {
        console.error('[AI Browser Guard] Download monitor error:', err);
      });
    });
  } catch {
    // downloads API may be unavailable in some contexts
  }

  // CDP debugger attachment monitor — fast in-session polling for low-latency
  // detection while the worker is alive. The 'cdp-monitor' alarm above is the
  // self-wake safety net for the idle windows when this interval is gone.
  monitorDebuggerAttachment((result) => {
    handleCdpDebuggerDetection(result).catch((err) => {
      console.error('[AI Browser Guard] CDP detection handler error:', err);
    });
  }, 3000);

  // CDP-layer network egress enforcement (ADR-007). Opt-in; attaches only under
  // an active delegation. Registering listeners here is a no-op when the
  // debugger API is unavailable.
  initCdpEnforcement({ getRuleForTab: getEffectiveRuleForTab, onBlock: reportCdpBlock });

  console.debug('[AI Browser Guard] Background service worker initialized');
}

/**
 * Run a single CDP attachment check and route any detection through the normal
 * handler. Invoked from the 'cdp-monitor' alarm so the check survives
 * service-worker teardown (the in-session setInterval poll does not).
 */
async function runCdpDebuggerCheck(): Promise<void> {
  const result = await detectDebuggerAttachment();
  if (result.detected) {
    await handleCdpDebuggerDetection(result);
  }
}

async function loadPersistedState(): Promise<void> {
  const stored = await getStorageState();
  state.delegationRules = stored.delegationRules;
  state.lifetimeStats = await getLifetimeStats();
  // Rehydrate the latched kill switch. Without this, an MV3 idle-timeout would
  // reconstruct it as inactive and silently lift the block (fail-open).
  state.killSwitch = await getKillSwitchState();
  state.notificationsEnabled = stored.settings.notificationsEnabled;
  state.cdpEnforcementEnabled = stored.settings.cdpEnforcementEnabled;

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
      // Persist the cleared state so a later SW restart does not re-arm a
      // kill switch the user has already reset.
      saveKillSwitchState(state.killSwitch).catch(() => { /* best effort */ });
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
      sendResponse({
        detectedAgents: agents,
        // Re-keyed to agent id, and only for origins that still match. Empty
        // unless the feature is on. See aisafety/attribution.ts.
        aiSafetyDeclarations: collectAiSafetyDeclarations(state.activeAgents, state.aiSafetyDeclarations),
        // The popup's session-delegation panel shows the session-wide rule;
        // per-agent grants are rendered on their agent cards from
        // delegationRules below.
        activeDelegation: getActiveSessionRule(),
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
      updateSettings(updates).then(() => getSettings()).then((settings) => {
        // Keep the hot-path cache in sync so the Notifications toggle takes
        // effect immediately without a service-worker restart.
        state.notificationsEnabled = settings.notificationsEnabled;
        // Apply the CDP-enforcement toggle immediately: turning it on attaches
        // currently-delegated tabs; turning it off detaches everything.
        const cdpChanged = state.cdpEnforcementEnabled !== settings.cdpEnforcementEnabled;
        state.cdpEnforcementEnabled = settings.cdpEnforcementEnabled;
        if (cdpChanged) {
          reconcileCdpEnforcement().catch(() => { /* non-critical */ });
        }
        // Opting out of ai-safety.txt discards everything the feature gathered,
        // matching the one-click-opt-out promise ADR-006 makes for the other
        // network features ("disabling the setting stops all outbound requests
        // immediately; queued events are cleared"). Leaving stale declarations
        // on disk and on screen after opt-out would contradict it.
        //
        // Gated on this update actually TOUCHING the flag, not merely on the
        // flag being off. It is off by default, so keying on its value alone
        // would fire a storage delete on every unrelated toggle (Notifications,
        // CDP), and — since the clear can now fail loudly — let an unrelated
        // toggle report a failure for a settings write that in fact landed.
        // Reading the payload needs no cached state, so unlike an edge check
        // against a remembered value it cannot be wrong after a worker restart.
        const touchedAiSafetyFlag = Object.prototype.hasOwnProperty.call(
          updates,
          'aiSafetyTxtEnabled',
        );
        if (touchedAiSafetyFlag && !settings.aiSafetyTxtEnabled) {
          // In-memory first: even if the storage delete fails, the declarations
          // leave the screen and no further requests can happen (the gate is
          // already off in settings).
          state.aiSafetyDeclarations.clear();
          return clearAiSafetyCache().then(
            () => sendResponse({ success: true, declarationsCleared: true }),
            // The setting itself SAVED; only the delete failed. Reporting
            // `success: false` would claim the opt-out did not happen — it did.
            // Reporting a flat `success: true` would claim the privacy policy's
            // promise ("turning the setting off deletes every stored
            // declaration") was kept when it was not. So the two outcomes are
            // reported separately and the popup tells the user.
            () => sendResponse({ success: true, declarationsCleared: false }),
          );
        }
        sendResponse({ success: true });
        return undefined;
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

    case 'REPORT_DOWNLOAD': {
      // Fallback path for the popup export: the popup hands us the bytes and we
      // download from the (non-transient) service worker via chrome.downloads,
      // so the download survives the popup window being torn down. Service
      // workers have no URL.createObjectURL, so we use a base64 data: URL.
      const { filename, json } = message.data as { filename?: string; json?: string };
      (async () => {
        if (typeof json !== 'string' || !chrome.downloads?.download) {
          sendResponse({ ok: false, error: 'unavailable' });
          return;
        }
        const { url, filename: safeName } = buildReportDownloadArgs(filename ?? '', json);
        try {
          const id = await chrome.downloads.download({ url, filename: safeName, saveAs: false });
          sendResponse({ ok: true, downloadId: id });
        } catch (err) {
          sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) });
        }
      })().catch((err) => {
        sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) });
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
        const result = await flushQueue();
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
      handleDomainWhitelist(tabId, domain).then(() => {
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

  // Create a new session. Attribute it to the rule that actually governs this
  // tab's agent (per-agent rule if one exists, else the session-wide rule).
  const session: AgentSession = {
    id: crypto.randomUUID(),
    agent: event.agent,
    delegationRule: getEffectiveRuleForTab(tabId),
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

  // Push the tab's effective rule so a session-wide grant (or none) is enforced
  // in the freshly-detecting tab without waiting for the next delegation change.
  chrome.tabs.sendMessage(tabId, {
    type: 'DELEGATION_UPDATE',
    data: getEffectiveRuleForTab(tabId),
    sentAt: new Date().toISOString(),
  }).catch(() => { /* tab may not have a content script yet */ });

  // AIM + Registry trust lookup (non-blocking)
  enrichAgentTrust(tabId, event.agent).catch(() => { /* non-critical */ });

  // Read the page origin's ai-safety.txt declaration (non-blocking, opt-in).
  //
  // Agent detection is deliberately the trigger, not navigation (ADR-009): the
  // declaration exists to be read before an agent acts on a page, this reuses an
  // existing hook rather than adding a navigation listener and its permission,
  // and it bounds the disclosure to "only while an agent is running".
  enrichDomainDeclaration(tabId, event.agent).catch(() => { /* non-critical */ });

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

  // Attach CDP enforcement if this tab is now an agent tab under active
  // delegation (opt-in; no-op when the feature is off).
  reconcileCdpEnforcement().catch(() => { /* non-critical */ });
}

/**
 * Read the ai-safety.txt declaration for the page an agent was detected on.
 *
 * Display-only, and deliberately kept out of `enrichAgentTrust`: that function
 * computes a trust SCORE for the agent, and a declaration must never feed it.
 * A declaration is a self-asserted claim by the site — draft section 5.1: a
 * consumer "MUST NOT treat a declaration as proof of the property it asserts,
 * and MUST NOT relax its own defenses solely because a domain claims a
 * favorable posture". Any domain can write `AI-Safe: true` for free. Keeping
 * the two functions separate means a later edit to the scoring logic cannot
 * accidentally pull a domain's self-assessment into it (ADR-009 section 4).
 */
async function enrichDomainDeclaration(tabId: number, agent: AgentIdentity): Promise<void> {
  const settings = (await getStorageState()).settings;
  // The gate lives here, at the call site, so the fresh-install zero-network
  // test exercises the same path production does.
  if (!settings.aiSafetyTxtEnabled) return;

  const origin = declarationOriginFor(agent.originUrl);
  const result = await lookupAiSafetyDeclaration(agent.originUrl);

  // The tab may have closed, or its agent changed, while the lookup was in
  // flight. Writing then would leak an entry that handleTabRemoved already
  // pruned, and the map would grow without bound. `agent.id` is a fresh UUID per
  // detection, so an id match means this is still the same detection.
  const current = state.activeAgents.get(tabId);
  if (!current || current.id !== agent.id) return;

  // Store the origin the result describes, so a reader can prove the two still
  // agree rather than trusting the tabId. Null (a non-HTTPS page we declined to
  // read) is a real value here, not a missing one: it must compare equal to the
  // same null on re-derivation so the honest "could not check" state still
  // renders, rather than being silently dropped as a mismatch.
  state.aiSafetyDeclarations.set(tabId, { origin, result });
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
  const activeRule = tabId !== undefined ? getEffectiveRuleForTab(tabId) : null;
  if (!activeRule) return;

  // processBoundaryViolation creates the alert, shows the notification, stores the pending
  // override, and logs the timeline event.
  const alert = processBoundaryViolation(tabId, violation, activeRule, state.activeSessions, state.notificationsEnabled);

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

/**
 * Surface a CDP-layer (browser network) block through the same path as a
 * page-realm boundary violation, so it lands in recent alerts, the timeline,
 * the badge, and lifetime stats. The request was already failed at the network
 * layer; this is reporting only. `network-request` is high-severity, so no
 * one-time override is offered (handleBoundaryViolation/classifyViolationSeverity).
 */
function reportCdpBlock(tabId: number, url: string, reason: string): void {
  const agent = state.activeAgents.get(tabId);
  const rule = getEffectiveRuleForTab(tabId);
  const violation: BoundaryViolation = {
    id: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
    agentId: agent?.id ?? 'unknown',
    attemptedAction: 'network-request',
    url,
    blockingRuleId: rule?.id ?? '',
    reason,
    userOverride: false,
  };
  handleBoundaryViolation(tabId, violation);
}

/**
 * Resolve the delegation rule in effect for a given tab: the rule bound to the
 * agent detected in this tab, else the session-wide rule, else none.
 */
function getEffectiveRuleForTab(tabId: number): DelegationRule | null {
  const agentId = state.activeAgents.get(tabId)?.id ?? null;
  return selectEffectiveRule(state.delegationRules, agentId);
}

/** The session-wide rule currently active, if any (for the popup panel). */
function getActiveSessionRule(): DelegationRule | null {
  return selectEffectiveRule(state.delegationRules, null);
}

/**
 * Push each tab the rule that actually governs it. Sending the per-tab
 * effective rule (rather than one global rule to everyone) is what keeps a
 * grant for one agent from leaking into another agent's tab.
 */
async function broadcastEffectiveRules(): Promise<void> {
  const tabs = await chrome.tabs.query({});
  for (const tab of tabs) {
    if (tab.id === undefined) continue;
    const effective = getEffectiveRuleForTab(tab.id);
    try {
      await chrome.tabs.sendMessage(tab.id, {
        type: 'DELEGATION_UPDATE',
        data: effective,
        sentAt: new Date().toISOString(),
      });
    } catch {
      // Tab may not have content script
    }
  }
}

async function handleDelegationUpdate(rule: DelegationRule): Promise<void> {
  // Add/replace the incoming rule and deactivate only prior rules in the SAME
  // scope (same agent, or the single session-wide slot). Grants for other
  // agents are left untouched — this is the fix for the "allow one agent grants
  // all agents" bug.
  state.delegationRules = applyDelegationUpdate(state.delegationRules, rule);

  await saveDelegationRules(state.delegationRules);

  // Route each tab its own effective rule.
  await broadcastEffectiveRules();

  updateBadge();

  // A grant/scope change can flip which tabs warrant browser-layer enforcement.
  await reconcileCdpEnforcement();
}

/**
 * Add a *.domain allow pattern to the rule governing the requesting tab.
 * Called when the user clicks "Allow on [domain]" in a blocked-action toast,
 * which originates from a specific tab — so the whitelist is applied to that
 * tab's effective rule, not to some other agent's grant.
 */
async function handleDomainWhitelist(tabId: number | undefined, domain: string): Promise<void> {
  const activeRule = tabId !== undefined ? getEffectiveRuleForTab(tabId) : null;
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

  // Re-route each tab its effective rule (this one now has the new pattern).
  await broadcastEffectiveRules();
}

async function executeKillSwitch(
  trigger: 'button' | 'keyboard-shortcut' | 'api'
): Promise<KillSwitchEvent> {
  const agentIds = Array.from(state.activeAgents.values()).map((a) => a.id);
  // Tabs with an active detected agent — closing these is the real hard stop.
  const agentTabIds = Array.from(state.activeAgents.keys());

  const event = await executeBackgroundKillSwitch(trigger, agentIds, [], agentTabIds);

  state.killSwitch.isActive = true;
  state.killSwitch.lastEvent = event;
  state.killSwitch.lastActivatedAt = event.timestamp;
  // Persist immediately so the latched block survives a service-worker restart.
  await saveKillSwitchState(state.killSwitch);

  // Clear active agents
  state.activeAgents.clear();

  // Deactivate all delegation rules
  for (const rule of state.delegationRules) {
    rule.isActive = false;
  }
  await saveDelegationRules(state.delegationRules);

  // End all sessions and generate reports. Driven off STORED sessions, not the
  // in-memory `state.activeSessions` map, which is empty after a service-worker
  // restart — sessions that survived in storage must still be ended and reported.
  await endStoredSessionsForKillSwitch(generateAndStoreReport);
  state.activeSessions.clear();

  await clearAllNotifications();
  updateBadge();

  // Detach all CDP enforcement sessions — activeAgents is now empty, so the
  // desired set is empty and every attached tab is released.
  await reconcileCdpEnforcement();

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

/**
 * Record (and, under a blocking delegation, cancel) an agent-initiated
 * download.
 *
 * A download is agent activity only when an agent is active. If none is yet
 * registered we run a fresh CDP check: a live debugger attachment means the
 * browser is being driven, so we register those tabs (creating sessions) before
 * attributing. With no active agent and no live attachment, the download is the
 * user's own action and is ignored — normal browsing is never flagged.
 */
async function handleDownloadCreated(item: chrome.downloads.DownloadItem): Promise<void> {
  const info = {
    id: item.id,
    url: item.url,
    finalUrl: item.finalUrl,
    filename: item.filename,
    referrer: item.referrer,
    byExtensionId: item.byExtensionId,
  };
  const ownId = typeof chrome.runtime?.id === 'string' ? chrome.runtime.id : undefined;

  // Our own report-export download is never agent activity.
  if (ownId && info.byExtensionId === ownId) return;

  // If no agent is registered yet, probe for a live CDP attachment and register
  // any attached tabs (which also creates their sessions) before attributing.
  if (state.activeAgents.size === 0) {
    const cdp = await detectDebuggerAttachment();
    if (cdp.detected) {
      await handleCdpDebuggerDetection(cdp);
    }
  }

  const activeTabs = Array.from(state.activeAgents.entries()).map(([tabId, agent]) => ({
    tabId,
    originUrl: agent.originUrl,
  }));

  if (shouldIgnoreDownload(info, activeTabs, ownId)) return;

  const { tabId, matchedByReferrer } = attributeDownload(info, activeTabs);
  const downloadUrl = info.finalUrl ?? info.url;
  const label = describeDownload(info);
  const rule = getEffectiveRuleForTab(tabId);

  // Under a delegation that does not permit download-file, cancel the download.
  let blocked = false;
  if (rule && !evaluateRule(rule, 'download-file', downloadUrl).allowed) {
    blocked = true;
    try {
      chrome.downloads.cancel(item.id, () => {
        // Swallow lastError — the download may have already completed.
        void chrome.runtime.lastError;
      });
    } catch {
      // cancel may fail if the download already finished
    }
  }

  const uncertain = matchedByReferrer ? '' : ' (attribution uncertain)';
  const event = createTimelineEvent(
    'download',
    downloadUrl,
    blocked ? `Blocked agent download: ${label}${uncertain}` : `Agent download: ${label}${uncertain}`,
    {
      attemptedAction: 'download-file',
      outcome: blocked ? 'blocked' : 'informational',
      ruleId: rule?.id,
    },
  );

  const sessionId = state.activeSessions.get(tabId);
  if (sessionId) {
    await updateSession(sessionId, (session) => appendEventToSession(session, event)).catch(() => {
      /* storage best-effort */
    });
  }

  if (blocked) {
    state.lastBlockAt = Date.now();
    state.lifetimeStats = {
      ...state.lifetimeStats,
      totalActionsBlocked: state.lifetimeStats.totalActionsBlocked + 1,
    };
    updateLifetimeStats(() => state.lifetimeStats).catch(() => { /* non-critical */ });
  }
  updateBadge();
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
  state.aiSafetyDeclarations.delete(tabId);
  // Release any CDP enforcement session for the closed tab.
  detachTab(tabId).catch(() => { /* tab already gone */ });
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
    }
  }

  if (changed) {
    await saveDelegationRules(state.delegationRules);
    // Re-route each tab its effective rule. Broadcasting a blanket `null` here
    // would drop OTHER agents' still-valid grants (and any session-wide
    // fallback) to pass-through — the per-agent isolation must hold on expiry,
    // not just on grant.
    await broadcastEffectiveRules();
    updateBadge();
    // Expiry must also tear down browser-layer enforcement for the lapsed tabs.
    await reconcileCdpEnforcement();
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
