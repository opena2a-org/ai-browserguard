/**
 * @vitest-environment jsdom
 *
 * Regression (#164): the kill switch capture, docs/screenshots/4-killswitch.png,
 * and the store slide and large promo tile that embed it showed a timeline
 * with the rows "Kill switch activated" / "All connections terminated", "CDP
 * sessions closed (2)", "WebDriver flags cleared" and "Delegation rules
 * revoked". scripts/generate-screenshots.mjs wrote them into the capture, and
 * the popup does not show them: its timeline lists the stored sessions, and
 * the kill switch ends each stored session that is still open, setting the
 * time it ended and the end reason 'kill-switch'. The generator now draws the
 * capture's timeline with scripts/screenshot-timeline.mjs from
 * KILL_SWITCH_SESSIONS. These cases check that the generator does so, that
 * those sessions are the ones the kill switch leaves, and that the drawing is
 * what the popup renders for the same sessions.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { drawTimeline, KILL_SWITCH_SESSIONS } from '../../scripts/screenshot-timeline.mjs';
import { endStoredSessionsForKillSwitch } from '../background/kill-switch-sessions';
import { appendEventToSession, createTimelineEvent } from '../session/timeline';
import { clearAllStorage, getSessions, saveSession } from '../session/storage';
import type { AgentSession } from '../session/types';
import type { AgentEvent } from '../types/events';
import type { AgentType } from '../types/agent';

const ROOT = resolve(__dirname, '../..');
const POPUP_HTML = readFileSync(resolve(ROOT, 'src/popup/index.html'), 'utf-8');
const GENERATOR = readFileSync(resolve(ROOT, 'scripts/generate-screenshots.mjs'), 'utf-8');

/** Text of the rows the kill switch capture staged before #164. */
const ROWS_STAGED_BEFORE = [
  'Kill switch activated',
  'All connections terminated',
  'CDP sessions closed',
  'WebDriver flags cleared',
  'Delegation rules revoked',
];

const EMPTY_SUMMARY: AgentSession['summary'] = {
  totalActions: 0,
  allowedActions: 0,
  blockedActions: 0,
  violations: 0,
  topUrls: [],
  durationSeconds: null,
};

interface Timeline {
  hidden: boolean;
  html: string;
}

/** The popup's HTML, which the generator loads from the build, without its script. */
function loadPopupDocument(): void {
  const parsed = new DOMParser().parseFromString(POPUP_HTML, 'text/html');
  parsed.querySelectorAll('script').forEach((el) => el.remove());
  document.body.replaceChildren(...Array.from(parsed.body.childNodes).map((n) => document.importNode(n, true)));
}

function timeline(): Timeline {
  return {
    hidden: document.getElementById('timeline-panel')!.classList.contains('hidden'),
    html: document.getElementById('timeline-list')!.innerHTML,
  };
}

/** The timeline scripts/screenshot-timeline.mjs draws for `sessions`. */
function drawn(sessions: AgentSession[]): Timeline {
  loadPopupDocument();
  drawTimeline(sessions);
  return timeline();
}

const originalChrome = (globalThis as Record<string, unknown>).chrome;

afterEach(() => {
  (globalThis as Record<string, unknown>).chrome = originalChrome;
});

/** The timeline the popup renders with the kill switch on and `sessions` stored. */
async function renderedByPopup(sessions: AgentSession[]): Promise<Timeline> {
  const answers: Record<string, unknown> = {
    STATUS_QUERY: {
      detectedAgents: [],
      activeDelegation: null,
      delegationRules: [],
      killSwitchActive: true,
      recentViolations: [],
      aiSafetyDeclarations: {},
    },
    SESSION_QUERY: { sessions },
    REPORTS_QUERY: { reports: [] },
    CONTRIBUTE_STATS: {},
  };
  (globalThis as Record<string, unknown>).chrome = {
    runtime: {
      id: 'test-extension',
      lastError: undefined,
      getManifest: () => ({ version: '0.0.0-test' }),
      onMessage: { addListener() {}, removeListener() {} },
      sendMessage: (msg: { type: string }, cb?: (r: unknown) => void) => {
        setTimeout(() => cb?.(answers[msg.type] ?? {}), 0);
      },
    },
    storage: {
      local: { get: async () => ({}), set: async () => {}, remove: async () => {} },
      onChanged: { addListener() {}, removeListener() {} },
    },
  };
  loadPopupDocument();
  // Imported once: each DOMContentLoaded renders the popup again.
  await import('../popup/popup');
  document.dispatchEvent(new Event('DOMContentLoaded'));
  // The status badge is the last part the popup renders.
  await vi.waitFor(
    () => expect(document.getElementById('status-text')!.textContent).toBe('Killed'),
    { timeout: 3000 },
  );
  return timeline();
}

const AT = '2026-10-20T09:15:00.000Z';

function entry(key: string, fields: Partial<AgentEvent> & Pick<AgentEvent, 'type' | 'url'>): AgentEvent {
  return { id: `event-${key}`, timestamp: AT, outcome: 'informational', description: key, ...fields };
}

function session(key: string, type: string, events: AgentEvent[], endedAt: string | null): AgentSession {
  return {
    id: `session-${key}`,
    agent: {
      id: `agent-${key}`,
      type: type as AgentType,
      detectionMethods: ['cdp-connection'],
      confidence: 'high',
      detectedAt: AT,
      originUrl: 'https://example.com/',
      observedCapabilities: [],
      isActive: true,
    },
    delegationRule: null,
    events,
    startedAt: AT,
    endedAt,
    endReason: endedAt === null ? null : 'kill-switch',
    summary: EMPTY_SUMMARY,
  };
}

const AGENT_TYPES = [
  'playwright',
  'puppeteer',
  'selenium',
  'anthropic-computer-use',
  'openai-operator',
  'cdp-generic',
  'webdriver-generic',
  'unknown',
  'a-type-the-popup-does-not-name',
];

const OTHER_SESSIONS: Array<[string, AgentSession[]]> = [
  [
    'one open session, with actions on long targets',
    [
      session('open', 'puppeteer', [
        entry('detected', { type: 'detection', url: 'https://shop.example.com/' }),
        entry('click', { type: 'action-allowed', url: 'https://shop.example.com/', attemptedAction: 'click', targetSelector: '#search', outcome: 'allowed' }),
        entry('submit', {
          type: 'action-blocked',
          url: 'https://shop.example.com/checkout',
          attemptedAction: 'submit-form',
          targetSelector: 'form#checkout-payment > button.confirm-order',
          outcome: 'blocked',
        }),
        entry('download', { type: 'download', url: 'https://files.example.com/exports/2026/october/report-final.csv' }),
      ], null),
    ],
  ],
  [
    'sessions of each agent type, open and ended, and one with no entries',
    [
      ...AGENT_TYPES.map((type, i) =>
        session(type, type, [entry(type, { type: 'detection', url: `https://site-${i}.example.com/` })], i % 2 === 0 ? null : AT),
      ),
      session('empty', 'playwright', [], AT),
    ],
  ],
  ['a session with no entries', [session('empty', 'selenium', [], null)]],
];

describe('the kill switch capture (#164)', () => {
  it('draws its timeline from KILL_SWITCH_SESSIONS and stages no timeline rows of its own', () => {
    expect(GENERATOR).toContain("import { drawTimeline, KILL_SWITCH_SESSIONS } from './screenshot-timeline.mjs';");
    expect(GENERATOR).toContain("'4-killswitch': KILL_SWITCH_SESSIONS");
    expect(GENERATOR).toContain('await page.evaluate(drawTimeline, sessions);');
    const capture = GENERATOR.indexOf("await screenshot('4-killswitch'");
    expect(capture).toBeGreaterThan(-1);
    expect(GENERATOR.slice(capture)).not.toContain('timeline-list');
    expect(GENERATOR.slice(capture)).not.toContain('timeline-panel');
    for (const row of ROWS_STAGED_BEFORE) {
      expect(GENERATOR).not.toContain(row);
    }
  });
});

describe('KILL_SWITCH_SESSIONS (#164)', () => {
  it('are the sessions of two detected agents as the kill switch leaves them', async () => {
    await clearAllStorage();
    // Each session as the background stores it when its agent is detected:
    // still open, holding the entry the detection added to its timeline.
    for (const staged of [...KILL_SWITCH_SESSIONS].reverse()) {
      const [detected] = staged.events;
      const detection: AgentEvent = {
        ...createTimelineEvent('detection', staged.agent.originUrl, detected.description, { outcome: 'informational' }),
        id: detected.id,
        timestamp: staged.startedAt,
      };
      const open: AgentSession = { ...staged, events: [], endedAt: null, endReason: null, summary: EMPTY_SUMMARY };
      await saveSession(appendEventToSession(open, detection));
    }

    const usedAt = KILL_SWITCH_SESSIONS[0].endedAt!;
    const ended = await endStoredSessionsForKillSwitch(async () => {}, () => usedAt);

    expect(ended).toEqual(KILL_SWITCH_SESSIONS.map((s) => s.id));
    expect(await getSessions()).toEqual(KILL_SWITCH_SESSIONS);
    expect(KILL_SWITCH_SESSIONS.map((s) => s.events.map((e) => e.description))).toEqual([
      ['Agent detected: Playwright'],
      ['Agent detected: Selenium'],
    ]);
  });
});

describe('drawTimeline (#164)', () => {
  it('draws KILL_SWITCH_SESSIONS as the popup renders them, each ended at the time the kill switch was used', async () => {
    const expected = drawn(KILL_SWITCH_SESSIONS);
    const usedAt = new Date(KILL_SWITCH_SESSIONS[0].endedAt!).toLocaleTimeString(undefined, {
      hour: '2-digit',
      minute: '2-digit',
    });
    const headers = [...document.querySelectorAll('#timeline-list .session-header')].map((el) => el.textContent ?? '');
    expect(expected.hidden).toBe(false);
    expect(headers).toHaveLength(2);
    expect(headers[0]).toContain('Playwright');
    expect(headers[1]).toContain('Selenium');
    for (const header of headers) {
      expect(header).toContain(`Ended ${usedAt}`);
    }
    for (const row of ROWS_STAGED_BEFORE) {
      expect(document.getElementById('timeline-panel')!.textContent).not.toContain(row);
    }

    expect(await renderedByPopup(KILL_SWITCH_SESSIONS)).toEqual(expected);
  });

  it.each(OTHER_SESSIONS)('draws %s as the popup renders it', async (_name, sessions) => {
    const expected = drawn(sessions);
    expect(await renderedByPopup(sessions)).toEqual(expected);
  });
});
