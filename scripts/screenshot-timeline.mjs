/**
 * The popup's session timeline, drawn for a store capture (#164).
 *
 * scripts/generate-screenshots.mjs loads the built popup in a plain page,
 * where `chrome` is not defined, so the popup script renders nothing and a
 * capture shows the static HTML with the staged state written into it. The
 * kill switch capture staged a timeline with the rows "Kill switch
 * activated", "CDP sessions closed (2)", "WebDriver flags cleared" and
 * "Delegation rules revoked", which the popup does not show. The popup's
 * timeline lists the stored sessions, and the kill switch ends each stored
 * session that is still open, setting the time it ended and the end reason
 * 'kill-switch' (src/background/kill-switch-sessions.ts).
 *
 * `drawTimeline` builds the elements renderTimelinePanel in src/popup/popup.ts
 * builds for a list of stored sessions, and KILL_SWITCH_SESSIONS are the
 * sessions the kill switch capture shows. src/__tests__/screenshot-timeline.test.ts
 * compares the drawing with the popup's, and the sessions with the ones the
 * kill switch leaves. `drawTimeline` runs inside the page through
 * `page.evaluate`, so it refers to nothing outside itself.
 */

/** When the kill switch in the kill switch capture was used. */
const KILL_SWITCH_USED_AT = '2026-10-20T14:40:01.000Z';

/**
 * A session as the background stores it after the kill switch ended it: it
 * started when its agent was detected on `url` at `detectedAt` and holds the
 * entry that detection added to its timeline.
 */
function endedByKillSwitch({ key, type, name, detectionMethods, url, detectedAt }) {
  return {
    id: `session-${key}`,
    agent: {
      id: `agent-${key}`,
      type,
      detectionMethods,
      confidence: 'high',
      detectedAt,
      originUrl: url,
      observedCapabilities: [],
      isActive: true,
    },
    delegationRule: null,
    events: [
      {
        id: `detection-${key}`,
        type: 'detection',
        timestamp: detectedAt,
        url,
        description: `Agent detected: ${name}`,
        outcome: 'informational',
      },
    ],
    startedAt: detectedAt,
    endedAt: KILL_SWITCH_USED_AT,
    endReason: 'kill-switch',
    summary: {
      totalActions: 0,
      allowedActions: 0,
      blockedActions: 0,
      violations: 0,
      topUrls: [new URL(url).hostname],
      durationSeconds: 0,
    },
  };
}

/**
 * The sessions of the two agents the detection capture shows, Playwright on
 * app.example.com and Selenium on test.example.org, after the kill switch
 * ended both. Newest first, the order the sessions are stored and listed in.
 */
export const KILL_SWITCH_SESSIONS = [
  endedByKillSwitch({
    key: 'playwright',
    type: 'playwright',
    name: 'Playwright',
    detectionMethods: ['cdp-connection'],
    url: 'https://app.example.com/',
    detectedAt: '2026-10-20T14:32:18.000Z',
  }),
  endedByKillSwitch({
    key: 'selenium',
    type: 'selenium',
    name: 'Selenium',
    detectionMethods: ['webdriver-flag'],
    url: 'https://test.example.org/',
    detectedAt: '2026-10-20T14:31:05.000Z',
  }),
];

/**
 * Fill `#timeline-list` of the popup document, and show or hide
 * `#timeline-panel`, the way the popup renders `sessions`.
 *
 * @param {Array<object>} sessions stored sessions, newest first
 */
export function drawTimeline(sessions) {
  const panel = document.getElementById('timeline-panel');
  const container = document.getElementById('timeline-list');

  const formatTimestamp = (iso) =>
    new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const formatTimeShort = (iso) =>
    new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
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
  const span = (className, text) => {
    const el = document.createElement('span');
    el.className = className;
    el.textContent = text;
    return el;
  };

  if (!sessions.some((s) => s.events.length > 0)) {
    panel.classList.add('hidden');
    return;
  }
  panel.classList.remove('hidden');
  container.replaceChildren();

  // One session starts expanded; several start collapsed.
  const startExpanded = sessions.length === 1;

  for (const session of sessions) {
    if (session.events.length === 0) continue;

    const header = document.createElement('div');
    header.className = 'session-header';
    header.setAttribute('role', 'button');
    header.setAttribute('tabindex', '0');

    const headerLeft = document.createElement('div');
    headerLeft.className = 'session-header-left';
    const count = session.events.length;
    headerLeft.append(
      span('session-agent-name', agentNames[session.agent.type] ?? session.agent.type),
      span('session-time-label', formatTimeShort(session.startedAt)),
      span('session-event-count', `${count} action${count === 1 ? '' : 's'}`),
    );

    const headerRight = document.createElement('div');
    headerRight.className = 'session-header-right';
    headerRight.append(
      session.endedAt === null
        ? span('session-status-badge session-status-active', 'Active')
        : span('session-time-label', `Ended ${formatTimeShort(session.endedAt)}`),
      span('session-chevron', startExpanded ? '-' : '+'),
    );
    header.append(headerLeft, headerRight);

    const eventRows = document.createElement('div');
    eventRows.className = 'session-events';
    if (!startExpanded) eventRows.classList.add('hidden');

    for (const event of session.events) {
      const row = document.createElement('div');
      row.className = 'session-event-row';
      const target = span(
        'session-event-target',
        event.targetSelector ? truncateUrl(event.targetSelector, 28) : truncateUrl(event.url, 28),
      );
      target.title = event.targetSelector ?? event.url;
      const outcomeClass = event.outcome === 'allowed'
        ? 'outcome-chip-allowed'
        : event.outcome === 'blocked'
          ? 'outcome-chip-blocked'
          : 'outcome-chip-info';
      row.append(
        span('session-event-arrow', '↳'),
        span('session-event-time', formatTimestamp(event.timestamp)),
        span('session-event-capability', event.attemptedAction ?? event.type),
        target,
        span(`outcome-chip ${outcomeClass}`, event.outcome),
      );
      eventRows.appendChild(row);
    }

    const group = document.createElement('div');
    group.className = 'session-group';
    group.append(header, eventRows);
    container.appendChild(group);
  }
}
