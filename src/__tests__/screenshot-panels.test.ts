/**
 * @vitest-environment jsdom
 *
 * Regression (#169): scripts/generate-screenshots.mjs staged parts of the
 * store captures that the popup never shows. The detection capture showed
 * detection cards with a percentage badge ('95%', '78%') where the popup shows
 * a 'DETECTED' badge and a 'Confidence: <level>' line, and timeline rows ('CDP
 * connection detected on tab', 'WebDriver flag set on navigator') where the
 * popup lists the stored sessions. The kill switch capture showed a disabled
 * 'Killed' button where the popup shows 'Resume Monitoring'. No capture showed
 * the Network Activity panel, which the popup shows in every state. The
 * generator now draws the detection panel, the kill switch button and the
 * Network Activity panel with scripts/screenshot-panels.mjs, and the detection
 * capture's timeline from DETECTION_SESSIONS with scripts/screenshot-timeline.mjs.
 * These cases check that the generator does so, that DETECTION_SESSIONS are
 * the sessions the background stores for the two detected agents, and that
 * the drawing is what the popup renders for the same state.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { DETECTED_AGENTS, DETECTION_SESSIONS, drawPopupPanels } from '../../scripts/screenshot-panels.mjs';
import { drawTimeline, KILL_SWITCH_SESSIONS } from '../../scripts/screenshot-timeline.mjs';
import { endStoredSessionsForKillSwitch } from '../background/kill-switch-sessions';
import { createRuleFromPreset } from '../delegation/rules';
import { appendEventToSession, createTimelineEvent } from '../session/timeline';
import { clearAllStorage, getSessions, saveSession } from '../session/storage';
import type { AgentSession } from '../session/types';
import type { AgentEvent } from '../types/events';
import type { AgentIdentity, AgentType, DetectionConfidence, DetectionMethod } from '../types/agent';
import type { DelegationRule } from '../types/delegation';

const ROOT = resolve(__dirname, '../..');
const POPUP_HTML = readFileSync(resolve(ROOT, 'src/popup/index.html'), 'utf-8');
const GENERATOR = readFileSync(resolve(ROOT, 'scripts/generate-screenshots.mjs'), 'utf-8');

/** Text the detection capture staged before #169 that the popup never shows. */
const STAGED_BEFORE = ['95%', '78%', 'CDP connection detected on tab', 'WebDriver flag set on navigator', 'navigator.webdriver'];

/** A user agent of Chrome 145 on macOS, the shape src/delegation/posture.ts reads. */
const CHROME_145 =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.7632.77 Safari/537.36';
const CHROME_120 =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.6099.71 Safari/537.36';

const EMPTY_SUMMARY: AgentSession['summary'] = {
  totalActions: 0,
  allowedActions: 0,
  blockedActions: 0,
  violations: 0,
  topUrls: [],
  durationSeconds: null,
};

interface PopupState {
  detectedAgents: AgentIdentity[];
  activeDelegation: DelegationRule | null;
  killSwitchActive: boolean;
  sessions: AgentSession[];
}

interface Panels {
  detection: string;
  killSwitch: string;
  network: string | undefined;
  networkNext: string | undefined;
  timelineHidden: boolean;
  timeline: string;
}

/** The popup's HTML, which the generator loads from the build, without its script. */
function loadPopupDocument(): void {
  const parsed = new DOMParser().parseFromString(POPUP_HTML, 'text/html');
  parsed.querySelectorAll('script').forEach((el) => el.remove());
  document.body.replaceChildren(...Array.from(parsed.body.childNodes).map((n) => document.importNode(n, true)));
}

function panels(): Panels {
  const network = document.getElementById('network-panel');
  return {
    detection: document.getElementById('detection-content')!.innerHTML,
    killSwitch: document.getElementById('kill-switch-btn')!.outerHTML,
    network: network?.outerHTML,
    networkNext: network?.nextElementSibling?.id,
    timelineHidden: document.getElementById('timeline-panel')!.classList.contains('hidden'),
    timeline: document.getElementById('timeline-list')!.innerHTML,
  };
}

/** What the generator draws for `state`. */
function drawn(state: PopupState): Panels {
  loadPopupDocument();
  if (state.sessions.length > 0) drawTimeline(state.sessions);
  drawPopupPanels({
    detectedAgents: state.detectedAgents,
    delegationActive: state.activeDelegation !== null,
    killSwitchActive: state.killSwitchActive,
  });
  return panels();
}

const originalChrome = (globalThis as Record<string, unknown>).chrome;

function useUserAgent(userAgent: string): void {
  Object.defineProperty(window.navigator, 'userAgent', { value: userAgent, configurable: true });
}

afterEach(() => {
  (globalThis as Record<string, unknown>).chrome = originalChrome;
  delete (window.navigator as unknown as Record<string, unknown>).userAgent;
});

/** What the popup renders when the background reports `state`. */
async function renderedByPopup(state: PopupState): Promise<Panels> {
  const answers: Record<string, unknown> = {
    STATUS_QUERY: {
      detectedAgents: state.detectedAgents,
      activeDelegation: state.activeDelegation,
      delegationRules: state.activeDelegation ? [state.activeDelegation] : [],
      killSwitchActive: state.killSwitchActive,
      recentViolations: [],
      aiSafetyDeclarations: {},
    },
    SESSION_QUERY: { sessions: state.sessions },
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
  // The popup adds the Network Activity panel after it renders the detection
  // panel, the kill switch button and the timeline.
  await vi.waitFor(() => expect(document.getElementById('network-panel')).not.toBeNull(), { timeout: 3000 });
  return panels();
}

const READ_ONLY_RULE = createRuleFromPreset('readOnly', { durationMinutes: 45 });

/** The state the popup holds in each capture. */
const CAPTURES: Array<[string, PopupState]> = [
  ['1-detection', { detectedAgents: DETECTED_AGENTS, activeDelegation: null, killSwitchActive: false, sessions: DETECTION_SESSIONS }],
  ['2-delegation', { detectedAgents: [], activeDelegation: null, killSwitchActive: false, sessions: [] }],
  ['3-readOnly', { detectedAgents: [], activeDelegation: READ_ONLY_RULE, killSwitchActive: false, sessions: [] }],
  ['4-killswitch', { detectedAgents: [], activeDelegation: null, killSwitchActive: true, sessions: KILL_SWITCH_SESSIONS }],
];

function agent(
  key: string,
  type: string,
  detectionMethods: DetectionMethod[],
  confidence: unknown,
  originUrl = `https://${key}.example.com/`,
): AgentIdentity {
  return {
    id: `agent-${key}`,
    type: type as AgentType,
    detectionMethods,
    confidence: confidence as DetectionConfidence,
    detectedAt: '2026-10-20T09:15:42.000Z',
    originUrl,
    observedCapabilities: [],
    isActive: true,
  };
}

const OTHER_AGENTS: Array<[string, AgentIdentity[]]> = [
  [
    'agents of each type the popup names and one it does not, at each confidence level',
    [
      agent('puppeteer', 'puppeteer', ['cdp-connection'], 'low'),
      agent('computer-use', 'anthropic-computer-use', ['behavioral-timing'], 'medium'),
      agent('operator', 'openai-operator', ['automation-flag'], 'confirmed'),
      agent('cdp', 'cdp-generic', ['cdp-connection', 'behavioral-precision'], 'high'),
      agent('webdriver', 'webdriver-generic', ['webdriver-flag'], 'high'),
      agent('unnamed', 'a-type-the-popup-does-not-name', ['cdp-connection'], 'high'),
    ],
  ],
  [
    'in-page agents, an agent with no detection method, and confidence values the popup does not know',
    [
      agent('in-page', 'unknown', ['synthetic-event'], 'medium'),
      agent('in-page-fingerprint', 'unknown', ['synthetic-event', 'framework-fingerprint'], 'confirmed'),
      agent('no-method', 'unknown', [], 'high'),
      agent('no-confidence', 'selenium', ['webdriver-flag'], undefined),
      agent('odd-confidence', 'playwright', ['cdp-connection'], 'certain'),
    ],
  ],
  [
    'an agent detected on a long address',
    [agent('long', 'playwright', ['cdp-connection'], 'high', 'https://checkout.payments.example.com/orders/2026/october/confirm?step=3')],
  ],
];

describe('the store captures (#169)', () => {
  it('draw the detection panel, the kill switch button and the Network Activity panel, and stage none of them', () => {
    expect(GENERATOR).toContain("import { DETECTED_AGENTS, DETECTION_SESSIONS, drawPopupPanels } from './screenshot-panels.mjs';");
    expect(GENERATOR).toContain("'1-detection': DETECTION_SESSIONS");
    expect(GENERATOR).toContain("const DETECTED = { '1-detection': DETECTED_AGENTS };");
    expect(GENERATOR).toContain("const DELEGATION_ACTIVE = ['3-readOnly'];");
    expect(GENERATOR).toContain('await page.evaluate(drawPopupPanels, {');
    const captures = GENERATOR.split('await screenshot(').slice(1);
    expect(captures).toHaveLength(4);
    for (const capture of captures) {
      for (const id of ['detection-content', 'kill-switch-btn', 'timeline-list', 'timeline-panel', 'network-panel']) {
        expect(capture).not.toContain(id);
      }
    }
    for (const text of STAGED_BEFORE) {
      expect(GENERATOR).not.toContain(text);
    }
    expect(GENERATOR).not.toContain("btn.textContent = 'Killed'");
  });

  it('report the version of Chrome the page runs in under the name Chrome reports', () => {
    expect(GENERATOR).toContain(
      "await cdp.send('Emulation.setUserAgentOverride', { userAgent: userAgent.replace('HeadlessChrome/', 'Chrome/') });",
    );
    expect(GENERATOR.indexOf('Emulation.setUserAgentOverride')).toBeLessThan(GENERATOR.indexOf('await page.goto('));
  });
});

describe('DETECTION_SESSIONS and DETECTED_AGENTS (#169)', () => {
  it('are the sessions the background stores for the two detected agents, which the kill switch ends as KILL_SWITCH_SESSIONS', async () => {
    await clearAllStorage();
    for (const staged of [...DETECTION_SESSIONS].reverse()) {
      const [detected] = staged.events;
      const detection: AgentEvent = {
        ...createTimelineEvent('detection', staged.agent.originUrl, detected.description, { outcome: 'informational' }),
        id: detected.id,
        timestamp: staged.startedAt,
      };
      const open: AgentSession = { ...staged, events: [], summary: EMPTY_SUMMARY };
      await saveSession(appendEventToSession(open, detection));
    }
    expect(await getSessions()).toEqual(DETECTION_SESSIONS);
    expect(DETECTION_SESSIONS.map((s) => [s.endedAt, s.endReason])).toEqual([
      [null, null],
      [null, null],
    ]);

    await endStoredSessionsForKillSwitch(async () => {}, () => KILL_SWITCH_SESSIONS[0].endedAt!);
    expect(await getSessions()).toEqual(KILL_SWITCH_SESSIONS);
  });

  it('list Selenium, detected first, then Playwright, with the agents of the sessions', () => {
    expect(DETECTED_AGENTS.map((a) => a.type)).toEqual(['selenium', 'playwright']);
    expect(DETECTED_AGENTS).toEqual([DETECTION_SESSIONS[1].agent, DETECTION_SESSIONS[0].agent]);
  });
});

describe('drawPopupPanels (#169)', () => {
  it.each(CAPTURES)('draws the %s capture as the popup renders it in Chrome 145', async (_name, state) => {
    useUserAgent(CHROME_145);
    const expected = drawn(state);
    expect(await renderedByPopup(state)).toEqual(expected);
  });

  it('draws the detection capture with the DETECTED badge and the confidence line, no percentage', () => {
    useUserAgent(CHROME_145);
    drawn(CAPTURES[0][1]);
    const cards = [...document.querySelectorAll('#detection-content .detection-card')];
    expect(cards.map((c) => c.querySelector('strong')?.textContent)).toEqual(['Selenium', 'Playwright']);
    for (const card of cards) {
      expect(card.querySelector('.severity-badge')?.textContent).toBe('DETECTED');
      expect(card.querySelector('.detection-confidence')?.textContent).toBe('Confidence: High');
      expect(card.textContent).not.toMatch(/\d%/);
    }
    const panel = document.getElementById('app')!.textContent!;
    for (const text of STAGED_BEFORE) {
      expect(panel).not.toContain(text);
    }
    const headers = [...document.querySelectorAll('#timeline-list .session-header')].map((el) => el.textContent ?? '');
    expect(headers).toHaveLength(2);
    expect(headers[0]).toContain('Playwright');
    expect(headers[1]).toContain('Selenium');
    for (const header of headers) expect(header).toContain('Active');

    const btn = document.getElementById('kill-switch-btn') as HTMLButtonElement;
    expect([btn.textContent, btn.disabled]).toEqual(['Kill Switch', false]);
    expect(document.getElementById('network-list')!.textContent).toBe(
      'Network activity is observed only while a delegation rule or the kill switch is active.',
    );
  });

  it('draws the kill switch capture with the Resume Monitoring button enabled and the empty Network Activity panel', () => {
    drawn(CAPTURES[3][1]);
    const btn = document.getElementById('kill-switch-btn') as HTMLButtonElement;
    expect([btn.textContent, btn.disabled]).toEqual(['Resume Monitoring', false]);
    expect(document.getElementById('network-panel')!.classList.contains('hidden')).toBe(false);
    expect(document.getElementById('network-list')!.textContent).toBe('No network requests observed this session.');
  });

  it.each(OTHER_AGENTS)('draws %s as the popup renders them', async (_name, agents) => {
    const state: PopupState = { detectedAgents: agents, activeDelegation: null, killSwitchActive: false, sessions: [] };
    for (const userAgent of [CHROME_145, CHROME_120]) {
      useUserAgent(userAgent);
      const expected = drawn(state);
      expect(await renderedByPopup(state)).toEqual(expected);
    }
    // jsdom's own user agent has no Chrome version, so the cards state no posture.
    delete (window.navigator as unknown as Record<string, unknown>).userAgent;
    const expected = drawn(state);
    expect(document.querySelector('.agent-posture-note')).toBeNull();
    expect(await renderedByPopup(state)).toEqual(expected);
  });
});
