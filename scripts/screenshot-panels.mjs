/**
 * The detection panel, the kill switch button and the Network Activity panel
 * of the popup, drawn for a store capture (#169).
 *
 * scripts/generate-screenshots.mjs loads the built popup in a plain page,
 * where `chrome` is not defined, so the popup script renders nothing and a
 * capture shows the static HTML with the staged state written into it. The
 * captures staged detection cards with a percentage badge ('95%', '78%') and
 * method tags the popup does not show, a disabled kill switch button labelled
 * 'Killed' while the popup shows 'Resume Monitoring', and no Network Activity
 * panel, which the popup shows in every state.
 *
 * `drawPopupPanels` builds the elements renderDetectionPanel,
 * renderKillSwitchPanel and renderNetworkPanel in src/popup/popup.ts build for
 * detected agents with no delegation rule, no trust score, no AI-safety
 * declaration and no Browser-layer state, and for no stored network requests.
 * DETECTED_AGENTS and DETECTION_SESSIONS are the agents and stored sessions the
 * detection capture shows. src/__tests__/screenshot-panels.test.ts compares the
 * drawing with the popup's. `drawPopupPanels` runs inside the page through
 * `page.evaluate`, so it refers to nothing outside itself.
 */

import { KILL_SWITCH_SESSIONS } from './screenshot-timeline.mjs';

/**
 * The sessions of the two agents in the detection capture, Playwright on
 * app.example.com and Selenium on test.example.org, while both are still
 * detected: the sessions of KILL_SWITCH_SESSIONS before the kill switch ended
 * them. Newest first, the order the sessions are stored and listed in.
 */
export const DETECTION_SESSIONS = KILL_SWITCH_SESSIONS.map((session) => ({
  ...session,
  endedAt: null,
  endReason: null,
}));

/**
 * The agents of DETECTION_SESSIONS in the order they were detected, the order
 * the background lists the detected agents in.
 */
export const DETECTED_AGENTS = DETECTION_SESSIONS.map((session) => session.agent).reverse();

/**
 * @typedef {object} PopupPanelsState
 * @property {Array<object>} detectedAgents the agents the background reports
 *   as detected, in its order
 * @property {boolean} delegationActive whether a delegation is active
 * @property {boolean} killSwitchActive whether the kill switch is on
 */

/**
 * Fill `#detection-content`, set `#kill-switch-btn` and add `#network-panel`
 * to the popup document the way the popup renders them for `state`.
 *
 * @param {PopupPanelsState} state
 */
export function drawPopupPanels(state) {
  const formatTimestamp = (iso) =>
    new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const agentNames = {
    playwright: 'Playwright',
    puppeteer: 'Puppeteer',
    selenium: 'Selenium',
    'anthropic-computer-use': 'Anthropic Computer Use',
    'openai-operator': 'OpenAI Operator',
    'cdp-generic': 'CDP Agent',
    'webdriver-generic': 'WebDriver Agent',
    unknown: 'Unknown Agent',
  };
  const confidenceLabels = { low: 'Low', medium: 'Medium', high: 'High', confirmed: 'Confirmed' };
  const confidenceScaleTitle =
    'How strongly the detection signals indicate automation. Levels, lowest to highest: Low, Medium, High, Confirmed.';
  const externalDriverTypes = [
    'playwright',
    'puppeteer',
    'selenium',
    'anthropic-computer-use',
    'openai-operator',
    'cdp-generic',
    'webdriver-generic',
  ];
  const pageRealmMethods = ['synthetic-event', 'framework-fingerprint'];
  const knownTools = ['playwright', 'puppeteer', 'selenium'];
  const truncateUrl = (url, maxLength) => {
    if (url.length <= maxLength) return url;
    try {
      const parsed = new URL(url);
      const available = maxLength - parsed.hostname.length - 3;
      if (available <= 0) return parsed.hostname.substring(0, maxLength - 3) + '...';
      return parsed.hostname + parsed.pathname.substring(0, available) + '...';
    } catch {
      return url.substring(0, maxLength - 3) + '...';
    }
  };
  // The popup states what the version of Chrome it runs in does about remote
  // debugging (src/delegation/posture.ts).
  const posture = (() => {
    const match = /\bChrome\/(\d+)\./.exec(navigator.userAgent);
    const major = match ? Number(match[1]) : null;
    if (major === null || !Number.isFinite(major) || major <= 0) return null;
    if (major >= 136) {
      return 'Your Chrome already refuses remote debugging of its default profile '
        + '(Chrome 136+). An external agent that reached this tab is '
        + 'running in a separate profile, or debugging was enabled when this browser was launched.';
    }
    return 'Updating Chrome (136+) makes it refuse remote debugging '
      + 'of your default profile — the strongest protection against external drivers.';
  })();

  // Detection panel (renderDetectionPanel).
  const detection = document.getElementById('detection-content');
  detection.replaceChildren();
  if (state.detectedAgents.length === 0) {
    const p = document.createElement('p');
    p.className = 'placeholder-text-inline';
    p.textContent = 'No agents detected';
    detection.appendChild(p);
  }
  for (const agent of state.detectedAgents) {
    const card = document.createElement('div');
    card.className = 'detection-card';

    const headerRow = document.createElement('div');
    headerRow.className = 'detection-card-header';
    const name = document.createElement('strong');
    name.textContent = agentNames[agent.type] ?? agent.type;
    const badge = document.createElement('span');
    badge.className = 'severity-badge severity-badge-high';
    badge.textContent = 'DETECTED';
    headerRow.appendChild(name);
    headerRow.appendChild(badge);

    const external = externalDriverTypes.includes(agent.type)
      || agent.detectionMethods.length === 0
      || !agent.detectionMethods.every((m) => pageRealmMethods.includes(m));
    const trustBadge = document.createElement('span');
    if (external) {
      trustBadge.className = 'agent-pill agent-pill-amber';
      trustBadge.textContent = 'Monitor only';
      trustBadge.title =
        'This agent drives the browser directly (CDP/WebDriver). AI Browser Guard can detect and alert on it, but cannot block the actions it takes in the page. Use the kill switch to close the tab it controls.';
    } else if (knownTools.includes(agent.type)) {
      trustBadge.className = 'agent-pill agent-pill-amber';
      trustBadge.textContent = 'Known Tool';
      trustBadge.title = `${agent.type} is a recognized automation framework`;
    } else {
      trustBadge.style.cssText = 'font-size: 11px; font-weight: 500; color: var(--text-secondary); margin-left: 4px;';
      trustBadge.textContent = 'No trust score';
      trustBadge.title = 'The registry trust lookup is off, or it has not returned a score for this agent type.';
    }
    headerRow.appendChild(trustBadge);

    let confidenceRow = null;
    if (typeof agent.confidence === 'string' && Object.hasOwn(confidenceLabels, agent.confidence)) {
      confidenceRow = document.createElement('div');
      confidenceRow.className = 'detection-confidence';
      confidenceRow.textContent = `Confidence: ${confidenceLabels[agent.confidence]}`;
      confidenceRow.title = confidenceScaleTitle;
    }

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
    quickAllowRow.className = 'agent-grant-row';
    quickAllowRow.style.cssText = 'display: flex; gap: 6px; margin-top: 6px; align-items: center;';
    const allowReadOnlyBtn = document.createElement('button');
    allowReadOnlyBtn.type = 'button';
    allowReadOnlyBtn.className = 'btn btn-secondary btn-sm';
    allowReadOnlyBtn.textContent = 'Allow Read-Only';
    const allowFullBtn = document.createElement('button');
    allowFullBtn.type = 'button';
    allowFullBtn.className = 'btn btn-primary btn-sm';
    allowFullBtn.textContent = 'Allow Full Access';
    quickAllowRow.appendChild(allowReadOnlyBtn);
    quickAllowRow.appendChild(allowFullBtn);

    card.appendChild(headerRow);
    if (confidenceRow) card.appendChild(confidenceRow);
    card.appendChild(metaRow);
    card.appendChild(urlRow);
    card.appendChild(quickAllowRow);
    if (external && posture) {
      const postureRow = document.createElement('div');
      postureRow.className = 'agent-posture-note';
      postureRow.style.cssText = 'font-size: 11px; color: var(--text-secondary); margin-top: 4px; line-height: 1.35;';
      postureRow.textContent = posture;
      card.appendChild(postureRow);
    }
    detection.appendChild(card);
  }

  // Kill switch button (renderKillSwitchPanel).
  const btn = document.getElementById('kill-switch-btn');
  if (state.killSwitchActive) {
    btn.textContent = 'Resume Monitoring';
    btn.disabled = false;
    btn.className = 'btn btn-primary btn-sm';
  } else if (state.detectedAgents.length > 0) {
    btn.textContent = 'Kill Switch';
    btn.disabled = false;
    btn.className = 'btn-danger-compact';
  } else {
    btn.textContent = 'Kill Switch';
    btn.disabled = true;
    btn.className = 'btn btn-secondary btn-sm';
  }

  // Network Activity panel (renderNetworkPanel), with no network requests
  // stored.
  let panel = document.getElementById('network-panel');
  if (!panel) {
    const metricsPanel = document.getElementById('metrics-panel');
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
  panel.classList.remove('hidden');
  document.getElementById('network-filters').replaceChildren();
  const list = document.getElementById('network-list');
  list.replaceChildren();
  const note = document.createElement('p');
  note.className = 'placeholder-text-inline';
  note.textContent = state.delegationActive || state.killSwitchActive
    ? 'No network requests observed this session.'
    : 'Network activity is observed only while a delegation rule or the kill switch is active.';
  list.appendChild(note);
}
