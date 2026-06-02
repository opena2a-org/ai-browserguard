/**
 * Popup script for AI Browser Guard.
 *
 * Controls the extension popup UI.
 */

import type { MessagePayload, MessageType } from '../types/events';
import type { AgentIdentity } from '../types/agent';
import type { DelegationRule } from '../types/delegation';
import type { AgentSession, LifetimeStats, UserSettings } from '../session/types';
import { DEFAULT_SETTINGS } from '../session/types';
import type { BoundaryAlert } from '../alerts/boundary';
import type { SessionReport } from '../session/report';
import { createInitialWizardState, renderWizard } from '../delegation/wizard';
import type { WizardState } from '../delegation/wizard';
import { createRuleFromPreset } from '../delegation/rules';
import type { AIMAuthState } from '../aim/auth';
import { getAIMAuthState, loginToAIM, logoutFromAIM, isTokenExpired } from '../aim/auth';
import { triggerJsonDownload } from './download';

interface PopupState {
  detectedAgents: AgentIdentity[];
  activeDelegation: DelegationRule | null;
  killSwitchActive: boolean;
  recentViolations: BoundaryAlert[];
  sessions: AgentSession[];
  wizardState: WizardState | null;
  loading: boolean;
  lifetimeStats: LifetimeStats | null;
  reports: SessionReport[];
  selectedReport: SessionReport | null;
  selectedSessionForNetwork: AgentSession | null;
  networkFilter: 'all' | 'agent' | 'user';
  aimAuth: AIMAuthState | null;
  settings: UserSettings;
  settingsPanelOpen: boolean;
  contributeStats: { totalContributed: number; queuedCount: number; lastFlushedAt: string | null; enabled: boolean } | null;
  showContributeTip: boolean;
}

let popupState: PopupState = {
  detectedAgents: [],
  activeDelegation: null,
  killSwitchActive: false,
  recentViolations: [],
  sessions: [],
  wizardState: null,
  loading: true,
  lifetimeStats: null,
  reports: [],
  selectedReport: null,
  selectedSessionForNetwork: null,
  networkFilter: 'all',
  aimAuth: null,
  settings: { ...DEFAULT_SETTINGS },
  settingsPanelOpen: false,
  contributeStats: null,
  showContributeTip: false,
};

// Holds the interval ID for the delegation countdown timer.
// Cleared whenever the popup re-renders to avoid duplicate timers.
let countdownIntervalId: ReturnType<typeof setInterval> | null = null;

function initialize(): void {
  document.addEventListener('DOMContentLoaded', () => {
    // Sync version from manifest to prevent hardcoded footer drift
    const manifest = chrome.runtime.getManifest();
    const footerText = document.querySelector('.footer-text');
    if (footerText && manifest.version) {
      footerText.textContent = `AI Browser Guard v${manifest.version}`;
    }
    setupEventListeners();
    queryBackgroundStatus();
  });
}

async function queryBackgroundStatus(): Promise<void> {
  try {
    const response = await sendToBackground('STATUS_QUERY', {});
    if (response && typeof response === 'object') {
      const data = response as {
        detectedAgents?: AgentIdentity[];
        activeDelegation?: DelegationRule | null;
        killSwitchActive?: boolean;
        recentViolations?: BoundaryAlert[];
      };
      popupState.detectedAgents = data.detectedAgents ?? [];
      popupState.activeDelegation = data.activeDelegation ?? null;
      popupState.killSwitchActive = data.killSwitchActive ?? false;
      popupState.recentViolations = data.recentViolations ?? [];
      popupState.lifetimeStats = (data as { lifetimeStats?: LifetimeStats }).lifetimeStats ?? null;
    }
  } catch {
    // Background may not be available
  }

  // Also fetch sessions
  try {
    const sessionResponse = await sendToBackground('SESSION_QUERY', {});
    if (sessionResponse && typeof sessionResponse === 'object') {
      const data = sessionResponse as { sessions?: AgentSession[] };
      popupState.sessions = data.sessions ?? [];
    }
  } catch {
    // Ignore
  }

  // Also fetch reports
  try {
    const reportsResponse = await sendToBackground('REPORTS_QUERY', {});
    if (reportsResponse && typeof reportsResponse === 'object') {
      const data = reportsResponse as { reports?: SessionReport[] };
      popupState.reports = data.reports ?? [];
    }
  } catch {
    // Ignore
  }

  // Load contribute stats
  try {
    const contributeResponse = await sendToBackground('CONTRIBUTE_STATS', {});
    if (contributeResponse && typeof contributeResponse === 'object') {
      popupState.contributeStats = contributeResponse as PopupState['contributeStats'];
    }
  } catch {
    // Ignore
  }

  // Check if consent tip should be shown
  try {
    const { getConsent, shouldShowTip } = await import('../contribute/client');
    const consent = await getConsent();
    popupState.showContributeTip = shouldShowTip(consent);
  } catch {
    // Ignore
  }

  // Load AIM auth state directly from storage
  try {
    const authState = await getAIMAuthState();
    popupState.aimAuth = authState;
  } catch {
    popupState.aimAuth = null;
  }

  // Load user settings from storage
  try {
    const result = await chrome.storage.local.get('settings');
    if (result.settings && typeof result.settings === 'object') {
      popupState.settings = { ...DEFAULT_SETTINGS, ...(result.settings as Partial<UserSettings>) };
    }
  } catch {
    // Use defaults
  }

  popupState.loading = false;
  renderAll();
}

function setupEventListeners(): void {
  const killSwitchBtn = document.getElementById('kill-switch-btn');
  if (killSwitchBtn) {
    killSwitchBtn.addEventListener('click', onKillSwitchClick);
  }

  const wizardBtn = document.getElementById('delegation-wizard-btn');
  if (wizardBtn) {
    wizardBtn.addEventListener('click', onDelegationWizardClick);
  }

  const settingsBtn = document.getElementById('settings-btn');
  if (settingsBtn) {
    settingsBtn.addEventListener('click', onSettingsToggle);
  }

  // Listen for live updates from background (guard required — chrome is undefined outside extension)
  if (typeof chrome !== 'undefined' && chrome.runtime?.onMessage) {
    chrome.runtime.onMessage.addListener((message: MessagePayload) => {
    if (!message || !message.type) return;

      switch (message.type) {
        case 'DETECTION_RESULT':
          queryBackgroundStatus();
          break;
        case 'KILL_SWITCH_RESULT':
          popupState.killSwitchActive = true;
          renderAll();
          break;
        case 'DELEGATION_UPDATE':
          queryBackgroundStatus();
          break;
      }
    });
  } // end chrome.runtime guard

  // Listen for delegation activation from wizard.
  // Optimistic update: apply to UI immediately so the popup responds instantly
  // even if the background service worker is sleeping (common in MV3).
  document.addEventListener('delegation-activated', ((e: CustomEvent<DelegationRule>) => {
    const rule = e.detail;

    // Update UI first — do not wait for the background response.
    popupState.activeDelegation = rule;
    popupState.wizardState = null;
    const wizardContainer = document.getElementById('wizard-container');
    if (wizardContainer) {
      wizardContainer.classList.add('hidden');
      wizardContainer.replaceChildren();
    }
    renderAll();

    // Sync to background asynchronously.
    sendToBackground('DELEGATION_UPDATE', rule).catch((err) => {
      console.error('[AI Browser Guard] Failed to sync delegation to background:', err);
    });
  }) as EventListener);
}

async function onKillSwitchClick(): Promise<void> {
  const btn = document.getElementById('kill-switch-btn') as HTMLButtonElement | null;
  if (btn) btn.disabled = true;

  try {
    await sendToBackground('KILL_SWITCH_ACTIVATE', { trigger: 'button' });
    popupState.killSwitchActive = true;
    popupState.detectedAgents = [];
    popupState.activeDelegation = null;
    renderAll();
  } catch {
    if (btn) btn.disabled = false;
  }
}

function onDelegationWizardClick(): void {
  const wizardContainer = document.getElementById('wizard-container');
  if (!wizardContainer) return;

  if (wizardContainer.classList.contains('hidden')) {
    wizardContainer.classList.remove('hidden');
    popupState.wizardState = createInitialWizardState();
    renderWizardUI();
  } else {
    wizardContainer.classList.add('hidden');
    wizardContainer.replaceChildren();
    popupState.wizardState = null;
  }
  // Re-render delegation panel so Configure/Cancel label updates
  renderDelegationPanel();
}

function renderWizardUI(): void {
  const wizardContainer = document.getElementById('wizard-container');
  if (!wizardContainer || !popupState.wizardState) return;

  renderWizard(wizardContainer, popupState.wizardState, (newState) => {
    popupState.wizardState = newState;
    renderWizardUI();
  });
}

function renderAll(): void {
  renderContributeTip();
  renderRecentBlockCallout();
  renderDetectionPanel();
  renderKillSwitchPanel();
  renderDelegationPanel();
  renderViolationsPanel();
  renderTimelinePanel();
  renderReportsPanel();
  renderNetworkPanel();
  renderMetricsPanel();
  renderSettingsPanel();
  renderStatusBadge();
}

/**
 * Recently-blocked call-out at the top of the popup. Surfaces the last 3
 * violations within the last 5 minutes with a one-click whitelist action so
 * the user has direct recovery from the alert that brought them here.
 *
 * If the user missed the inline toast AND missed the action-icon badge,
 * this is the third and final attribution layer: opening the popup
 * immediately tells them what was blocked and how to unblock it.
 */
const RECENT_BLOCK_WINDOW_MS = 5 * 60 * 1000;
const RECENT_BLOCK_MAX_ITEMS = 3;

function renderRecentBlockCallout(): void {
  const callout = document.getElementById('recent-block-callout');
  const list = document.getElementById('recent-block-list');
  if (!callout || !list) return;

  const now = Date.now();
  const fresh = popupState.recentViolations.filter((alert) => {
    const ts = Date.parse(alert.violation.timestamp);
    return Number.isFinite(ts) && now - ts < RECENT_BLOCK_WINDOW_MS;
  });

  if (fresh.length === 0) {
    callout.classList.add('hidden');
    return;
  }
  callout.classList.remove('hidden');

  // Clear with textContent so we don't accumulate listeners between renders.
  list.textContent = '';

  const recent = fresh.slice(-RECENT_BLOCK_MAX_ITEMS).reverse();
  for (const alert of recent) {
    const row = document.createElement('div');
    row.className = 'recent-block-row';

    const meta = document.createElement('div');
    meta.className = 'recent-block-meta';

    const action = document.createElement('div');
    action.className = 'recent-block-action';
    action.textContent = `Blocked ${alert.violation.attemptedAction}`;

    const urlEl = document.createElement('div');
    urlEl.className = 'recent-block-url';
    urlEl.textContent = truncateUrl(alert.violation.url);

    const ts = document.createElement('div');
    ts.className = 'recent-block-ts';
    ts.textContent = formatTimestamp(alert.violation.timestamp);

    meta.appendChild(action);
    meta.appendChild(urlEl);
    meta.appendChild(ts);

    const actions = document.createElement('div');
    actions.className = 'recent-block-actions';

    let domain: string | null = null;
    try {
      domain = new URL(alert.violation.url).hostname;
    } catch { /* skip if malformed */ }

    if (domain) {
      const whitelistBtn = document.createElement('button');
      whitelistBtn.className = 'btn btn-secondary recent-block-btn';
      whitelistBtn.textContent = `Whitelist ${domain}`;
      whitelistBtn.addEventListener('click', () => {
        const d = domain as string;
        sendToBackground('DOMAIN_WHITELIST', { domain: d }).then(() => {
          queryBackgroundStatus();
        }).catch(() => { /* ignore */ });
      });
      actions.appendChild(whitelistBtn);
    }

    row.appendChild(meta);
    row.appendChild(actions);
    list.appendChild(row);
  }
}

function renderContributeTip(): void {
  // Remove existing tip if present
  const existingTip = document.getElementById('contribute-tip');
  if (existingTip) {
    existingTip.remove();
  }

  if (!popupState.showContributeTip) return;

  const detectionCount = popupState.lifetimeStats?.totalSessions ?? 0;

  const tip = document.createElement('div');
  tip.id = 'contribute-tip';
  tip.className = 'contribute-tip';

  const text = document.createElement('div');
  text.className = 'contribute-tip-text';
  text.textContent = `You've detected ${detectionCount} AI agent${detectionCount === 1 ? '' : 's'}. Share anonymized detection patterns to help other users identify AI activity.`;

  const actions = document.createElement('div');
  actions.className = 'contribute-tip-actions';

  const dismissBtn = document.createElement('button');
  dismissBtn.className = 'btn btn-secondary btn-sm';
  dismissBtn.textContent = 'Dismiss';
  dismissBtn.addEventListener('click', () => {
    sendToBackground('CONTRIBUTE_TIP_DISMISS', {}).catch(() => { /* ignore */ });
    popupState.showContributeTip = false;
    tip.remove();
  });

  const enableBtn = document.createElement('button');
  enableBtn.className = 'btn btn-primary btn-sm';
  enableBtn.textContent = 'Enable';
  enableBtn.addEventListener('click', () => {
    sendToBackground('CONTRIBUTE_ENABLE', {}).then(() => {
      popupState.showContributeTip = false;
      if (popupState.contributeStats) {
        popupState.contributeStats.enabled = true;
      }
      renderAll();
    }).catch(() => { /* ignore */ });
  });

  actions.appendChild(dismissBtn);
  actions.appendChild(enableBtn);
  tip.appendChild(text);
  tip.appendChild(actions);

  // Insert above the metrics panel (or at the end of #app before footer)
  const metricsPanel = document.getElementById('metrics-panel');
  if (metricsPanel?.parentElement) {
    metricsPanel.parentElement.insertBefore(tip, metricsPanel);
  }
}

function renderDetectionPanel(): void {
  const container = document.getElementById('detection-content');
  if (!container) return;

  function renderPlaceholder(text: string): void {
    container!.replaceChildren();
    const p = document.createElement('p');
    p.className = 'placeholder-text-inline';
    p.textContent = text;
    container!.appendChild(p);
  }

  if (popupState.loading) {
    renderPlaceholder('Loading...');
    return;
  }

  if (popupState.detectedAgents.length === 0) {
    renderPlaceholder('No agents detected');
    return;
  }

  container.replaceChildren();
  for (const agent of popupState.detectedAgents) {
    const card = document.createElement('div');
    card.className = 'detection-card';

    const headerRow = document.createElement('div');
    headerRow.style.cssText = 'display: flex; justify-content: space-between; align-items: center; margin-bottom: 2px;';

    const name = document.createElement('strong');
    name.textContent = formatAgentType(agent.type);

    const badge = document.createElement('span');
    badge.className = 'severity-badge severity-badge-high';
    badge.textContent = 'DETECTED';

    headerRow.appendChild(name);
    headerRow.appendChild(badge);

    // Trust score badge (from AIM/Registry)
    // If user has an active delegation rule, show "Managed" instead of raw score.
    // Common frameworks (Playwright, Puppeteer, Selenium) get a "Known tool" indicator.
    const KNOWN_TOOLS = new Set(['playwright', 'puppeteer', 'selenium']);
    const isKnownTool = KNOWN_TOOLS.has(agent.type);
    const hasActiveDelegation = popupState.activeDelegation?.isActive === true;

    const trustBadge = document.createElement('span');
    if (hasActiveDelegation && (isKnownTool || (agent.trustScore !== undefined && agent.trustScore < 0.3))) {
      // User has explicitly set delegation rules — agent is "managed" regardless of registry score
      trustBadge.style.cssText = 'font-size: 11px; font-weight: 600; padding: 1px 6px; border-radius: 3px; color: white; background: #06b6d4; margin-left: 4px;';
      trustBadge.textContent = 'Managed';
      trustBadge.title = 'You have an active delegation rule for this agent';
    } else if (agent.trustScore !== undefined && agent.trustScore !== null) {
      const score = agent.trustScore;
      let trustColor: string;
      let trustLabel: string;
      if (score > 0.7) {
        trustColor = '#22c55e'; // green
        trustLabel = 'Trusted';
      } else if (score >= 0.3) {
        trustColor = '#f59e0b'; // yellow/amber
        trustLabel = 'Known';
      } else if (isKnownTool) {
        trustColor = '#f59e0b'; // amber for known tools not in registry
        trustLabel = 'Known Tool';
      } else {
        trustColor = '#ef4444'; // red
        trustLabel = 'Untrusted';
      }
      trustBadge.style.cssText = `font-size: 11px; font-weight: 600; padding: 1px 6px; border-radius: 3px; color: white; background: ${trustColor}; margin-left: 4px;`;
      trustBadge.textContent = `${trustLabel} (${score.toFixed(1)})`;
      trustBadge.title = agent.label ?? `Trust: ${score}`;
    } else if (isKnownTool) {
      trustBadge.style.cssText = 'font-size: 11px; font-weight: 600; padding: 1px 6px; border-radius: 3px; color: white; background: #f59e0b; margin-left: 4px;';
      trustBadge.textContent = 'Known Tool';
      trustBadge.title = `${agent.type} is a recognized automation framework`;
    } else {
      trustBadge.style.cssText = 'font-size: 11px; font-weight: 500; color: var(--text-secondary); margin-left: 4px;';
      trustBadge.textContent = 'AIM: N/A';
    }
    headerRow.appendChild(trustBadge);

    const metaRow = document.createElement('div');
    metaRow.style.cssText = 'font-size: 12px; color: var(--text-secondary); font-weight: 500;';

    const ts = document.createElement('span');
    ts.textContent = formatTimestamp(agent.detectedAt) + ' ';
    metaRow.appendChild(ts);

    for (const m of agent.detectionMethods) {
      const tag = document.createElement('span');
      tag.className = 'method-tag';
      tag.textContent = m;
      metaRow.appendChild(tag);
    }

    const urlRow = document.createElement('div');
    urlRow.style.cssText = 'font-size: 12px; color: var(--text-secondary); font-weight: 500; margin-top: 2px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;';
    urlRow.textContent = truncateUrl(agent.originUrl, 45);
    urlRow.title = agent.originUrl;

    const quickAllowRow = document.createElement('div');
    quickAllowRow.style.cssText = 'display: flex; gap: 6px; margin-top: 6px;';

    const allowReadOnlyBtn = document.createElement('button');
    allowReadOnlyBtn.type = 'button';
    allowReadOnlyBtn.className = 'btn btn-secondary btn-sm';
    allowReadOnlyBtn.textContent = 'Allow Read-Only';
    allowReadOnlyBtn.addEventListener('click', () => {
      onQuickAllowClick('readOnly');
    });

    const allowFullBtn = document.createElement('button');
    allowFullBtn.type = 'button';
    allowFullBtn.className = 'btn btn-primary btn-sm';
    allowFullBtn.textContent = 'Allow Full Access';
    allowFullBtn.addEventListener('click', () => {
      onQuickAllowClick('fullAccess');
    });

    quickAllowRow.appendChild(allowReadOnlyBtn);
    quickAllowRow.appendChild(allowFullBtn);

    card.appendChild(headerRow);
    card.appendChild(metaRow);
    card.appendChild(urlRow);
    card.appendChild(quickAllowRow);
    container.appendChild(card);
  }
}

function renderKillSwitchPanel(): void {
  const btn = document.getElementById('kill-switch-btn') as HTMLButtonElement | null;
  if (!btn) return;

  if (popupState.killSwitchActive) {
    // Replace kill switch button with Resume Monitoring
    btn.textContent = 'Resume Monitoring';
    btn.disabled = false;
    btn.className = 'btn btn-primary btn-sm';
    btn.onclick = () => { onResumeMonitoringClick().catch(() => { /* ignore */ }); };
  } else if (popupState.detectedAgents.length > 0) {
    // Agent active — show kill switch enabled and dangerous
    btn.textContent = 'Kill Switch';
    btn.disabled = false;
    btn.className = 'btn-danger-compact';
    btn.onclick = () => { onKillSwitchClick().catch(() => { /* ignore */ }); };
  } else {
    // Idle — no agent to kill, show as neutral/inactive
    btn.textContent = 'Kill Switch';
    btn.disabled = true;
    btn.className = 'btn btn-secondary btn-sm';
    btn.onclick = null;
  }
}

async function onResumeMonitoringClick(): Promise<void> {
  const btn = document.getElementById('kill-switch-btn') as HTMLButtonElement | null;
  if (btn) btn.disabled = true;

  try {
    await sendToBackground('KILL_SWITCH_RESET', {});
    popupState.killSwitchActive = false;
    renderAll();
  } catch {
    if (btn) btn.disabled = false;
  }
}

function onQuickAllowClick(preset: 'readOnly' | 'fullAccess'): void {
  const rule = createRuleFromPreset(preset);

  // Optimistic update — same pattern as wizard activation.
  popupState.activeDelegation = rule;
  popupState.wizardState = null;
  const wizardContainer = document.getElementById('wizard-container');
  if (wizardContainer) {
    wizardContainer.classList.add('hidden');
    wizardContainer.replaceChildren();
  }
  renderAll();

  sendToBackground('DELEGATION_UPDATE', rule).catch((err) => {
    console.error('[AI Browser Guard] Failed to sync quick-allow to background:', err);
  });
}

function renderDelegationPanel(): void {
  // Clear any existing countdown timer to avoid duplicate intervals
  if (countdownIntervalId !== null) {
    clearInterval(countdownIntervalId);
    countdownIntervalId = null;
  }

  const content = document.getElementById('delegation-content');
  if (!content) return;

  if (popupState.activeDelegation) {
    const rule = popupState.activeDelegation;
    const presetNames: Record<string, string> = {
      readOnly: 'Read-Only',
      limited: 'Limited',
      fullAccess: 'Full Access',
    };

    content.replaceChildren();
    const row = document.createElement('div');
    row.className = 'delegation-empty';

    const labelSpan = document.createElement('span');
    const strong = document.createElement('strong');
    strong.textContent = presetNames[rule.preset] ?? rule.preset;
    labelSpan.appendChild(strong);

    if (rule.scope.timeBound) {
      const expiresAt = new Date(rule.scope.timeBound.expiresAt).getTime();
      const timeSpan = document.createElement('span');
      timeSpan.id = 'delegation-countdown';
      timeSpan.style.cssText = 'font-size: 12px; font-weight: 500;';
      labelSpan.appendChild(timeSpan);

      function updateCountdown(): void {
        const remaining = expiresAt - Date.now();
        if (remaining <= 0) {
          // Clear the interval and mark as expired
          if (countdownIntervalId !== null) {
            clearInterval(countdownIntervalId);
            countdownIntervalId = null;
          }
          timeSpan.style.color = 'var(--color-danger)';
          timeSpan.textContent = ' (Expired)';

          // If re-query finds no active rule, renderAll will hide the countdown
          queryBackgroundStatus().catch(() => { /* ignore */ });
          return;
        }

        const totalSeconds = Math.floor(remaining / 1000);
        const mins = Math.floor(totalSeconds / 60);
        const secs = totalSeconds % 60;
        const paddedSecs = secs.toString().padStart(2, '0');
        timeSpan.style.color = remaining < 60000
          ? 'var(--color-danger)'
          : 'var(--color-warning)';
        timeSpan.textContent = ` (${mins}:${paddedSecs} left)`;
      }

      // Run immediately, then update every second
      updateCountdown();
      countdownIntervalId = setInterval(updateCountdown, 1000);
    }

    const changeBtn = document.createElement('button');
    changeBtn.id = 'delegation-wizard-btn';
    changeBtn.className = 'btn btn-secondary btn-sm';
    changeBtn.textContent = 'Change';
    changeBtn.addEventListener('click', onDelegationWizardClick);

    row.appendChild(labelSpan);
    row.appendChild(changeBtn);
    content.appendChild(row);
  } else {
    const wizardOpen = popupState.wizardState !== null;
    content.replaceChildren();
    const empty = document.createElement('div');
    empty.className = 'delegation-empty';

    const placeholder = document.createElement('span');
    placeholder.className = 'placeholder-text-inline';
    placeholder.textContent = 'No delegation active';

    const wizardBtn = document.createElement('button');
    wizardBtn.id = 'delegation-wizard-btn';
    wizardBtn.className = `btn ${wizardOpen ? 'btn-secondary' : 'btn-primary'} btn-sm`;
    wizardBtn.textContent = wizardOpen ? 'Cancel' : 'Configure';
    wizardBtn.addEventListener('click', onDelegationWizardClick);

    empty.appendChild(placeholder);
    empty.appendChild(wizardBtn);
    content.appendChild(empty);
  }
}

function renderViolationsPanel(): void {
  const panel = document.getElementById('violations-panel');
  const container = document.getElementById('violations-list');
  if (!container || !panel) return;

  if (popupState.recentViolations.length === 0) {
    panel.classList.add('hidden');
    return;
  }

  panel.classList.remove('hidden');
  container.replaceChildren();

  // Quick-whitelist: show recently blocked domains with one-click allow
  const blockedDomains = new Map<string, number>();
  for (const alert of popupState.recentViolations) {
    try {
      const domain = new URL(alert.violation.url).hostname;
      blockedDomains.set(domain, (blockedDomains.get(domain) ?? 0) + 1);
    } catch { /* skip invalid URLs */ }
  }
  if (blockedDomains.size > 0 && popupState.activeDelegation) {
    const whitelistSection = document.createElement('div');
    whitelistSection.style.cssText = 'margin-bottom: 12px; padding: 8px; background: rgba(6, 182, 212, 0.05); border: 1px solid rgba(6, 182, 212, 0.15); border-radius: 6px;';

    const whitelistHeader = document.createElement('div');
    whitelistHeader.style.cssText = 'font-size: 11px; font-weight: 600; color: var(--text-secondary); margin-bottom: 6px; text-transform: uppercase; letter-spacing: 0.5px;';
    whitelistHeader.textContent = 'Recently Blocked Domains';
    whitelistSection.appendChild(whitelistHeader);

    for (const [domain, count] of blockedDomains) {
      const row = document.createElement('div');
      row.style.cssText = 'display: flex; justify-content: space-between; align-items: center; padding: 4px 0;';

      const domainLabel = document.createElement('span');
      domainLabel.style.cssText = 'font-size: 12px; color: var(--text-primary);';
      domainLabel.textContent = `${domain} (${count})`;

      const allowBtn = document.createElement('button');
      allowBtn.className = 'btn btn-secondary';
      allowBtn.style.cssText = 'padding: 2px 10px; font-size: 11px; color: #06b6d4; border-color: rgba(6, 182, 212, 0.3);';
      allowBtn.textContent = 'Allow';
      allowBtn.addEventListener('click', () => {
        sendToBackground('DOMAIN_WHITELIST', { domain }).then(() => {
          queryBackgroundStatus();
        }).catch(() => { /* ignore */ });
      });

      row.appendChild(domainLabel);
      row.appendChild(allowBtn);
      whitelistSection.appendChild(row);
    }
    container.appendChild(whitelistSection);
  }

  for (const alert of popupState.recentViolations.slice(-10).reverse()) {
    const item = document.createElement('div');
    item.className = 'event-item';

    const dot = document.createElement('div');
    dot.className = 'event-outcome outcome-blocked';

    const body = document.createElement('div');
    body.style.cssText = 'flex: 1; min-width: 0;';

    const topRow = document.createElement('div');
    topRow.style.cssText = 'display: flex; justify-content: space-between;';

    const titleSpan = document.createElement('span');
    titleSpan.style.cssText = 'font-size: 13px; font-weight: 600;';
    titleSpan.textContent = alert.title;

    const sevBadge = document.createElement('span');
    sevBadge.className = `severity-badge severity-${alert.severity}`;
    sevBadge.textContent = alert.severity;

    topRow.appendChild(titleSpan);
    topRow.appendChild(sevBadge);

    const urlLine = document.createElement('div');
    urlLine.style.cssText = 'font-size: 12px; color: var(--text-secondary); font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;';
    urlLine.textContent = truncateUrl(alert.violation.url);

    const tsLine = document.createElement('div');
    tsLine.style.cssText = 'font-size: 11px; color: var(--text-secondary); font-weight: 500;';
    tsLine.textContent = formatTimestamp(alert.violation.timestamp);

    body.appendChild(topRow);
    body.appendChild(urlLine);
    body.appendChild(tsLine);
    item.appendChild(dot);
    item.appendChild(body);
    container.appendChild(item);
  }
}

function renderTimelinePanel(): void {
  const panel = document.getElementById('timeline-panel');
  const container = document.getElementById('timeline-list');
  if (!container || !panel) return;

  const sessions = popupState.sessions;

  // Hide the panel if there are no sessions with events
  const hasSessions = sessions.some(s => s.events.length > 0);
  if (!hasSessions) {
    panel.classList.add('hidden');
    return;
  }

  panel.classList.remove('hidden');
  container.replaceChildren();

  // Show "No session history" message if sessions array is empty
  if (sessions.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'placeholder-text-inline';
    empty.textContent = 'No session history';
    container.appendChild(empty);
    return;
  }

  // Only one session: start expanded. Multiple sessions: collapsed by default.
  const startExpanded = sessions.length === 1;

  for (const session of sessions) {
    // Skip sessions with no events
    if (session.events.length === 0) continue;

    const group = document.createElement('div');
    group.className = 'session-group';

    // --- Session header ---
    const header = document.createElement('div');
    header.className = 'session-header';
    header.setAttribute('role', 'button');
    header.setAttribute('tabindex', '0');

    const headerLeft = document.createElement('div');
    headerLeft.className = 'session-header-left';

    const agentName = document.createElement('span');
    agentName.className = 'session-agent-name';
    agentName.textContent = formatAgentType(session.agent.type);

    const startLabel = document.createElement('span');
    startLabel.className = 'session-time-label';
    startLabel.textContent = formatTimeShort(session.startedAt);

    const countLabel = document.createElement('span');
    countLabel.className = 'session-event-count';
    countLabel.textContent = `${session.events.length} action${session.events.length === 1 ? '' : 's'}`;

    headerLeft.appendChild(agentName);
    headerLeft.appendChild(startLabel);
    headerLeft.appendChild(countLabel);

    const headerRight = document.createElement('div');
    headerRight.className = 'session-header-right';

    if (session.endedAt === null) {
      const activeBadge = document.createElement('span');
      activeBadge.className = 'session-status-badge session-status-active';
      activeBadge.textContent = 'Active';
      headerRight.appendChild(activeBadge);
    } else {
      const endLabel = document.createElement('span');
      endLabel.className = 'session-time-label';
      endLabel.textContent = `Ended ${formatTimeShort(session.endedAt)}`;
      headerRight.appendChild(endLabel);
    }

    const chevron = document.createElement('span');
    chevron.className = 'session-chevron';
    chevron.textContent = startExpanded ? '-' : '+';
    headerRight.appendChild(chevron);

    header.appendChild(headerLeft);
    header.appendChild(headerRight);

    // --- Event rows container ---
    const eventRows = document.createElement('div');
    eventRows.className = 'session-events';
    if (!startExpanded) {
      eventRows.classList.add('hidden');
    }

    for (const event of session.events) {
      const row = document.createElement('div');
      row.className = 'session-event-row';

      const arrow = document.createElement('span');
      arrow.className = 'session-event-arrow';
      arrow.textContent = '\u21b3'; // downward-right arrow

      const timeCell = document.createElement('span');
      timeCell.className = 'session-event-time';
      timeCell.textContent = formatTimestamp(event.timestamp);

      const capabilityCell = document.createElement('span');
      capabilityCell.className = 'session-event-capability';
      capabilityCell.textContent = event.attemptedAction ?? event.type;

      const targetCell = document.createElement('span');
      targetCell.className = 'session-event-target';
      const target = event.targetSelector
        ? truncateUrl(event.targetSelector, 28)
        : truncateUrl(event.url, 28);
      targetCell.textContent = target;
      targetCell.title = event.targetSelector ?? event.url;

      const outcomeChip = document.createElement('span');
      const outcomeClass = event.outcome === 'allowed'
        ? 'outcome-chip-allowed'
        : event.outcome === 'blocked'
          ? 'outcome-chip-blocked'
          : 'outcome-chip-info';
      outcomeChip.className = `outcome-chip ${outcomeClass}`;
      outcomeChip.textContent = event.outcome;

      row.appendChild(arrow);
      row.appendChild(timeCell);
      row.appendChild(capabilityCell);
      row.appendChild(targetCell);
      row.appendChild(outcomeChip);
      eventRows.appendChild(row);
    }

    // Toggle expand/collapse on header click
    function toggleGroup(): void {
      const isHidden = eventRows.classList.contains('hidden');
      if (isHidden) {
        eventRows.classList.remove('hidden');
        chevron.textContent = '-';
      } else {
        eventRows.classList.add('hidden');
        chevron.textContent = '+';
      }
    }

    header.addEventListener('click', toggleGroup);
    header.addEventListener('keydown', (e: KeyboardEvent) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        toggleGroup();
      }
    });

    group.appendChild(header);
    group.appendChild(eventRows);
    container.appendChild(group);
  }
}

function renderReportsPanel(): void {
  let panel = document.getElementById('reports-panel');
  if (!panel) {
    // Create the reports panel dynamically if not in HTML
    const metricsPanel = document.getElementById('metrics-panel');
    if (!metricsPanel?.parentElement) return;
    panel = document.createElement('div');
    panel.id = 'reports-panel';
    panel.className = 'panel';

    const header = document.createElement('div');
    header.className = 'panel-header';
    const heading = document.createElement('h3');
    heading.textContent = 'Session Reports';
    header.appendChild(heading);

    const list = document.createElement('div');
    list.id = 'reports-list';

    panel.appendChild(header);
    panel.appendChild(list);
    metricsPanel.parentElement.insertBefore(panel, metricsPanel);
  }

  const container = document.getElementById('reports-list');
  if (!container) return;

  if (popupState.reports.length === 0) {
    panel.classList.add('hidden');
    return;
  }

  panel.classList.remove('hidden');
  container.replaceChildren();

  // Show report detail view if a report is selected
  if (popupState.selectedReport) {
    const report = popupState.selectedReport;

    const backBtn = document.createElement('button');
    backBtn.className = 'btn btn-secondary btn-sm';
    backBtn.textContent = 'Back';
    backBtn.style.cssText = 'margin-bottom: 8px;';
    backBtn.addEventListener('click', () => {
      popupState.selectedReport = null;
      renderReportsPanel();
    });
    container.appendChild(backBtn);

    const detail = document.createElement('div');
    detail.style.cssText = 'font-size: 12px; line-height: 1.6;';

    const lines = [
      `Agent: ${formatAgentType(report.agentType)}`,
      `Duration: ${report.durationSeconds !== null ? `${report.durationSeconds}s` : 'N/A'}`,
      `End reason: ${report.endReason ?? 'N/A'}`,
      `Actions: ${report.actionSummary.total} total, ${report.actionSummary.allowed} allowed, ${report.actionSummary.blocked} blocked`,
      `Events: ${report.totalEvents}`,
    ];

    if (report.delegationRuleSummary) {
      lines.push(`Delegation: ${report.delegationRuleSummary.preset}`);
    }

    if (Object.keys(report.violationsByCapability).length > 0) {
      lines.push('Violations:');
      for (const [cap, count] of Object.entries(report.violationsByCapability)) {
        lines.push(`  ${cap}: ${count}`);
      }
    }

    if (report.networkSummary) {
      lines.push(`Network: ${report.networkSummary.totalRequests} requests (${report.networkSummary.agentInitiated} agent, ${report.networkSummary.uniqueDomains} domains)`);
    }

    detail.replaceChildren();
    for (const line of lines) {
      const lineEl = document.createElement('div');
      lineEl.textContent = line;
      detail.appendChild(lineEl);
    }
    container.appendChild(detail);

    const exportBtn = document.createElement('button');
    exportBtn.className = 'btn btn-secondary btn-sm';
    exportBtn.textContent = 'Export JSON';
    exportBtn.style.cssText = 'margin-top: 8px;';
    exportBtn.addEventListener('click', () => {
      const json = JSON.stringify(report, null, 2);
      const filename = `report-${report.sessionId.substring(0, 8)}.json`;
      // Hardened anchor download with a service-worker fallback. The popup is a
      // transient window, so the worker (non-transient) downloads via
      // chrome.downloads if the in-popup anchor path throws. See ./download.ts.
      void triggerJsonDownload(filename, json, {
        fallback: async (name, body) => {
          await sendToBackground('REPORT_DOWNLOAD', { filename: name, json: body });
        },
      }).catch((err) => {
        console.error('[ABG] report export failed', err);
      });
    });
    container.appendChild(exportBtn);

    return;
  }

  // Report list view
  for (const report of popupState.reports.slice(0, 10)) {
    const row = document.createElement('div');
    row.className = 'event-item';
    row.style.cssText = 'cursor: pointer;';

    const body = document.createElement('div');
    body.style.cssText = 'flex: 1; min-width: 0;';

    const topRow = document.createElement('div');
    topRow.style.cssText = 'display: flex; justify-content: space-between; align-items: center;';

    const agentLabel = document.createElement('span');
    agentLabel.style.cssText = 'font-size: 13px; font-weight: 600;';
    agentLabel.textContent = formatAgentType(report.agentType);

    const dateLabel = document.createElement('span');
    dateLabel.style.cssText = 'font-size: 11px; color: var(--text-secondary);';
    dateLabel.textContent = formatTimestamp(report.startedAt);

    topRow.appendChild(agentLabel);
    topRow.appendChild(dateLabel);

    const statsRow = document.createElement('div');
    statsRow.style.cssText = 'font-size: 12px; color: var(--text-secondary); font-weight: 500;';
    const duration = report.durationSeconds !== null ? `${report.durationSeconds}s` : 'N/A';
    statsRow.textContent = `${report.actionSummary.total} actions, ${duration}`;

    const btnRow = document.createElement('div');
    btnRow.style.cssText = 'display: flex; gap: 4px; margin-top: 4px;';

    const viewBtn = document.createElement('button');
    viewBtn.className = 'btn btn-secondary btn-sm';
    viewBtn.textContent = 'View Report';
    viewBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      popupState.selectedReport = report;
      renderReportsPanel();
    });
    btnRow.appendChild(viewBtn);

    body.appendChild(topRow);
    body.appendChild(statsRow);
    body.appendChild(btnRow);
    row.appendChild(body);
    container.appendChild(row);
  }
}

function renderNetworkPanel(): void {
  let panel = document.getElementById('network-panel');

  // Find a session with network events to display
  const sessionWithNetwork = popupState.selectedSessionForNetwork
    ?? popupState.sessions.find(s => s.networkEvents && s.networkEvents.length > 0)
    ?? null;

  if (!panel) {
    const metricsPanel = document.getElementById('metrics-panel');
    if (!metricsPanel?.parentElement) return;
    panel = document.createElement('div');
    panel.id = 'network-panel';
    panel.className = 'panel';

    const header = document.createElement('div');
    header.className = 'panel-header';
    const heading = document.createElement('h3');
    heading.textContent = 'Network Activity';
    header.appendChild(heading);

    const filters = document.createElement('div');
    filters.id = 'network-filters';

    const list = document.createElement('div');
    list.id = 'network-list';

    panel.appendChild(header);
    panel.appendChild(filters);
    panel.appendChild(list);
    metricsPanel.parentElement.insertBefore(panel, metricsPanel);
  }

  const filtersContainer = document.getElementById('network-filters');
  const container = document.getElementById('network-list');
  if (!container || !filtersContainer) return;

  const events = sessionWithNetwork?.networkEvents ?? [];
  if (events.length === 0) {
    panel.classList.add('hidden');
    return;
  }

  panel.classList.remove('hidden');

  // Render filter buttons
  filtersContainer.replaceChildren();
  const filterRow = document.createElement('div');
  filterRow.style.cssText = 'display: flex; gap: 4px; margin-bottom: 8px; padding: 0 8px;';

  const filters: Array<{ label: string; value: 'all' | 'agent' | 'user' }> = [
    { label: 'All', value: 'all' },
    { label: 'Agent', value: 'agent' },
    { label: 'User', value: 'user' },
  ];

  for (const filter of filters) {
    const btn = document.createElement('button');
    btn.className = `btn btn-sm ${popupState.networkFilter === filter.value ? 'btn-primary' : 'btn-secondary'}`;
    btn.textContent = filter.label;
    btn.addEventListener('click', () => {
      popupState.networkFilter = filter.value;
      renderNetworkPanel();
    });
    filterRow.appendChild(btn);
  }
  filtersContainer.appendChild(filterRow);

  // Filter events
  const filtered = popupState.networkFilter === 'all'
    ? events
    : events.filter(e => e.initiator === popupState.networkFilter);

  container.replaceChildren();

  if (filtered.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'placeholder-text-inline';
    empty.textContent = 'No matching network events';
    container.appendChild(empty);
    return;
  }

  // Show last 50 events, newest first
  const display = filtered.slice(-50).reverse();
  for (const event of display) {
    const row = document.createElement('div');
    row.className = 'session-event-row';

    const methodCell = document.createElement('span');
    methodCell.style.cssText = 'font-size: 11px; font-weight: 700; width: 36px; flex-shrink: 0;';
    methodCell.textContent = event.method;

    const urlCell = document.createElement('span');
    urlCell.style.cssText = 'font-size: 11px; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;';
    urlCell.textContent = truncateUrl(event.url, 35);
    urlCell.title = event.url;

    const initiatorChip = document.createElement('span');
    const chipClass = event.initiator === 'agent' ? 'outcome-chip-blocked' : 'outcome-chip-allowed';
    initiatorChip.className = `outcome-chip ${chipClass}`;
    initiatorChip.textContent = event.initiator;

    const timeCell = document.createElement('span');
    timeCell.style.cssText = 'font-size: 10px; color: var(--text-secondary); width: 55px; text-align: right; flex-shrink: 0;';
    timeCell.textContent = formatTimestamp(event.timestamp);

    row.appendChild(methodCell);
    row.appendChild(urlCell);
    row.appendChild(initiatorChip);
    row.appendChild(timeCell);
    container.appendChild(row);
  }
}

function renderMetricsPanel(): void {
  const panel = document.getElementById('metrics-panel');
  const grid = document.getElementById('metrics-grid');
  const since = document.getElementById('metrics-since');
  if (!panel || !grid || !since) return;

  const stats = popupState.lifetimeStats;
  if (!stats || stats.totalSessions === 0) {
    panel.classList.add('hidden');
    return;
  }

  panel.classList.remove('hidden');
  grid.replaceChildren();

  // Sessions monitored
  addMetricCell(grid, String(stats.totalSessions), 'sessions monitored');

  // Actions blocked — show 0 as a positive ("no violations")
  if (stats.totalActionsBlocked > 0) {
    addMetricCell(grid, String(stats.totalActionsBlocked), 'actions blocked');
  } else {
    addMetricCell(grid, 'None', 'violations detected');
  }

  // Top detected agent framework
  const types = Object.entries(stats.agentTypesDetected);
  if (types.length > 0) {
    const topType = types.sort((a, b) => b[1] - a[1])[0][0];
    addMetricCell(grid, formatAgentType(topType), 'most seen framework');
  } else {
    const uniqueCount = types.length;
    addMetricCell(grid, String(uniqueCount), 'framework types');
  }

  // Contributions metric (if enabled and has contributed)
  if (popupState.contributeStats?.enabled && popupState.contributeStats.totalContributed > 0) {
    addMetricCell(grid, String(popupState.contributeStats.totalContributed), 'contributed');
  }

  // "Active since" line
  since.textContent = '';
  if (stats.firstActiveAt) {
    const date = new Date(stats.firstActiveAt);
    const daysSince = Math.floor((Date.now() - date.getTime()) / 86400000);
    const dateStr = date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
    const sinceText = document.createElement('span');
    sinceText.textContent = daysSince === 0
      ? `Monitoring active since today (${dateStr})`
      : `Monitoring active since ${dateStr} (${daysSince} day${daysSince === 1 ? '' : 's'})`;
    since.appendChild(sinceText);
  }
}

function addMetricCell(container: HTMLElement, value: string, label: string): void {
  const cell = document.createElement('div');
  cell.className = 'metric-cell';

  const val = document.createElement('div');
  val.className = 'metric-value';
  val.textContent = value;

  const lbl = document.createElement('div');
  lbl.className = 'metric-label';
  lbl.textContent = label;

  cell.appendChild(val);
  cell.appendChild(lbl);
  container.appendChild(cell);
}

function onSettingsToggle(): void {
  popupState.settingsPanelOpen = !popupState.settingsPanelOpen;
  const panel = document.getElementById('settings-panel');
  if (panel) {
    if (popupState.settingsPanelOpen) {
      panel.classList.remove('hidden');
    } else {
      panel.classList.add('hidden');
    }
  }
  renderSettingsPanel();
}

function renderSettingsPanel(): void {
  const panel = document.getElementById('settings-panel');
  const container = document.getElementById('settings-content');
  if (!panel || !container) return;

  if (!popupState.settingsPanelOpen) {
    panel.classList.add('hidden');
    return;
  }

  panel.classList.remove('hidden');
  container.replaceChildren();

  // Toggle settings
  const toggles: Array<{
    key: keyof UserSettings;
    label: string;
    description: string;
  }> = [
    {
      key: 'notificationsEnabled',
      label: 'Notifications',
      description: 'Show Chrome notifications for violations',
    },
  ];

  for (const toggle of toggles) {
    const row = document.createElement('div');
    row.className = 'settings-row';

    const labelWrap = document.createElement('div');

    const label = document.createElement('div');
    label.className = 'settings-label';
    label.textContent = toggle.label;

    const desc = document.createElement('div');
    desc.className = 'settings-description';
    desc.textContent = toggle.description;

    labelWrap.appendChild(label);
    labelWrap.appendChild(desc);

    const switchLabel = document.createElement('label');
    switchLabel.className = 'toggle-switch';

    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = Boolean(popupState.settings[toggle.key]);
    input.addEventListener('change', () => {
      popupState.settings = {
        ...popupState.settings,
        [toggle.key]: input.checked,
      };
      sendToBackground('SETTINGS_UPDATE', {
        [toggle.key]: input.checked,
      }).catch(() => { /* ignore */ });
    });

    const slider = document.createElement('span');
    slider.className = 'toggle-slider';

    switchLabel.appendChild(input);
    switchLabel.appendChild(slider);

    row.appendChild(labelWrap);
    row.appendChild(switchLabel);
    container.appendChild(row);
  }

  // Community Trust Data section
  const contributeSection = document.createElement('div');
  contributeSection.style.cssText = 'padding-top: 6px; margin-top: 2px;';

  const contributeSectionTitle = document.createElement('div');
  contributeSectionTitle.className = 'settings-label';
  contributeSectionTitle.style.cssText = 'margin-bottom: 4px; font-size: 11px; font-weight: 600; color: var(--text-secondary); text-transform: uppercase; letter-spacing: 0.06em;';
  contributeSectionTitle.textContent = 'Community Trust Data';
  contributeSection.appendChild(contributeSectionTitle);

  const contributeRow = document.createElement('div');
  contributeRow.className = 'settings-row';

  const contributeLabelWrap = document.createElement('div');

  const contributeLabel = document.createElement('div');
  contributeLabel.className = 'settings-label';
  contributeLabel.textContent = 'Share anonymized data';

  const contributeDesc = document.createElement('div');
  contributeDesc.className = 'settings-description';
  contributeDesc.textContent = 'Help build community trust scores for AI agents. Only anonymized framework types and action counts are shared. No URLs, page content, or personal data.';

  contributeLabelWrap.appendChild(contributeLabel);
  contributeLabelWrap.appendChild(contributeDesc);

  const contributeSwitchLabel = document.createElement('label');
  contributeSwitchLabel.className = 'toggle-switch';

  const contributeInput = document.createElement('input');
  contributeInput.type = 'checkbox';
  contributeInput.checked = popupState.contributeStats?.enabled ?? false;
  contributeInput.addEventListener('change', () => {
    const msgType = contributeInput.checked ? 'CONTRIBUTE_ENABLE' : 'CONTRIBUTE_DISABLE';
    sendToBackground(msgType, {}).then(() => {
      if (popupState.contributeStats) {
        popupState.contributeStats.enabled = contributeInput.checked;
      }
      renderSettingsPanel();
    }).catch(() => { /* ignore */ });
  });

  const contributeSlider = document.createElement('span');
  contributeSlider.className = 'toggle-slider';

  contributeSwitchLabel.appendChild(contributeInput);
  contributeSwitchLabel.appendChild(contributeSlider);

  contributeRow.appendChild(contributeLabelWrap);
  contributeRow.appendChild(contributeSwitchLabel);
  contributeSection.appendChild(contributeRow);

  // Show stats if contribute is enabled
  if (popupState.contributeStats?.enabled) {
    const statsDiv = document.createElement('div');
    statsDiv.className = 'contribute-stat';

    const parts: string[] = [];
    if (popupState.contributeStats.totalContributed > 0) {
      parts.push(`${popupState.contributeStats.totalContributed} events contributed`);
    }
    if (popupState.contributeStats.lastFlushedAt) {
      const lastFlush = new Date(popupState.contributeStats.lastFlushedAt);
      parts.push(`last sent ${lastFlush.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`);
    }
    if (popupState.contributeStats.queuedCount > 0) {
      parts.push(`${popupState.contributeStats.queuedCount} queued`);
    }

    if (parts.length > 0) {
      statsDiv.textContent = parts.join(' / ');
    } else {
      statsDiv.textContent = 'Enabled -- data will be contributed after detections';
    }
    contributeSection.appendChild(statsDiv);
  }

  container.appendChild(contributeSection);
}

function renderStatusBadge(): void {
  const indicator = document.getElementById('status-indicator');
  const statusText = document.getElementById('status-text');
  if (!indicator || !statusText) return;

  indicator.classList.remove('status-idle', 'status-detected', 'status-killed', 'status-delegated');

  if (popupState.killSwitchActive) {
    indicator.classList.add('status-killed');
    statusText.textContent = 'Killed';
  } else if (popupState.detectedAgents.length > 0) {
    indicator.classList.add('status-detected');
    statusText.textContent = `${popupState.detectedAgents.length} Agent(s) Detected`;
  } else if (popupState.activeDelegation) {
    indicator.classList.add('status-delegated');
    statusText.textContent = 'Delegated';
  } else {
    indicator.classList.add('status-idle');
    statusText.textContent = 'Monitoring';
  }
}

async function sendToBackground(type: MessageType, data: unknown): Promise<unknown> {
  const message: MessagePayload = {
    type,
    data,
    sentAt: new Date().toISOString(),
  };

  if (typeof chrome === 'undefined' || !chrome.runtime) {
    return Promise.reject(new Error('Chrome runtime not available'));
  }

  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else {
        resolve(response);
      }
    });
  });
}

function formatTimestamp(isoTimestamp: string): string {
  const date = new Date(isoTimestamp);
  return date.toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

// Compact HH:MM format for space-constrained contexts (session header row).
function formatTimeShort(isoTimestamp: string): string {
  const date = new Date(isoTimestamp);
  return date.toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
  });
}

function formatAgentType(type: string): string {
  const names: Record<string, string> = {
    playwright: 'Playwright',
    puppeteer: 'Puppeteer',
    selenium: 'Selenium',
    'anthropic-computer-use': 'Anthropic Computer Use',
    'openai-operator': 'OpenAI Operator',
    'cdp-generic': 'CDP Agent',
    'webdriver-generic': 'WebDriver Agent',
    unknown: 'Unknown Agent',
  };
  return names[type] ?? type;
}

function truncateUrl(url: string, maxLength: number = 40): string {
  if (url.length <= maxLength) return url;
  try {
    const parsed = new URL(url);
    const host = parsed.hostname;
    const path = parsed.pathname;
    const available = maxLength - host.length - 3;
    if (available <= 0) return host.substring(0, maxLength - 3) + '...';
    return host + path.substring(0, available) + '...';
  } catch {
    return url.substring(0, maxLength - 3) + '...';
  }
}

initialize();
