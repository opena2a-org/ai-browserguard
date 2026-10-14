/**
 * A further detection in a tab continues that tab's session (#122).
 *
 * Each detection reported for a tab once started a new stored session, a
 * second and later one from the same tab included. Six detections in one tab
 * were enough to push another tab's session out of the store of the last 5,
 * and a page detected twice had two sessions for its violations to go to.
 *
 * Driven through the real background worker and the repository's chrome mock.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { chromeMock } from '../__tests__/setup';
import { createRuleFromPreset } from '../delegation/rules';
import type { AgentSession } from '../session/types';
import type { BoundaryViolation } from '../types/events';

type Listener = (msg: unknown, sender: unknown, sendResponse: (r: unknown) => void) => boolean;

const POPUP = { id: 'test-id', url: 'chrome-extension://test-id/dist/popup/index.html' };

const step = (ms = 10) => vi.advanceTimersByTimeAsync(ms);

function tabSender(tabId: number, url: string) {
  return { id: 'test-id', tab: { id: tabId }, frameId: 0, url, origin: new URL(url).origin };
}

async function loadWorker(): Promise<Listener> {
  const downloads = chromeMock.downloads as unknown as Record<string, unknown>;
  downloads.onCreated = { addListener: vi.fn(), removeListener: vi.fn() };
  chromeMock.runtime.onMessage.addListener.mockClear();
  chromeMock.tabs.onRemoved.addListener.mockClear();
  await import('./index');
  await step();
  const calls = chromeMock.runtime.onMessage.addListener.mock.calls;
  return calls[calls.length - 1][0] as Listener;
}

/** Report a detection from the page in `tabId`, without waiting for it to be handled. */
function detect(h: Listener, tabId: number, id: string, type: string, url: string): void {
  const agent = { id, type, detectionMethods: ['framework-fingerprint'], confidence: 'confirmed',
    detectedAt: new Date().toISOString(), originUrl: url, observedCapabilities: [], isActive: true };
  h({ type: 'DETECTION_RESULT', data: { id: `det-${id}`, timestamp: new Date().toISOString(),
    methods: ['framework-fingerprint'], confidence: 'confirmed', agent, url, signals: {} } },
  tabSender(tabId, url), vi.fn());
}

async function blockTextInput(h: Listener, tabId: number, url: string, id: string): Promise<void> {
  const violation: BoundaryViolation = {
    id,
    timestamp: new Date().toISOString(),
    agentId: '',
    attemptedAction: 'type-text',
    url,
    targetSelector: '#q',
    blockingRuleId: 'rule',
    reason: 'Delegation does not permit text input',
    userOverride: false,
  };
  h({ type: 'BOUNDARY_CHECK_REQUEST', data: violation }, tabSender(tabId, url), vi.fn());
  await step();
}

async function closeTab(tabId: number): Promise<void> {
  const calls = chromeMock.tabs.onRemoved.addListener.mock.calls as unknown as Array<[(id: number, info: unknown) => void]>;
  expect(calls.length, 'the worker must listen for a closed tab').toBeGreaterThan(0);
  for (const [listener] of calls) listener(tabId, { windowId: 1, isWindowClosing: false });
  await step();
}

/** The stored sessions, newest first, as chrome.storage.local holds them. */
async function storedSessions(): Promise<AgentSession[]> {
  const { sessions } = (await chromeMock.storage.local.get('sessions')) as { sessions?: AgentSession[] };
  return sessions ?? [];
}

function detectionUrls(session: AgentSession): string[] {
  return session.events.filter((e) => e.type === 'detection').map((e) => e.url);
}

function sessionsMonitored(h: Listener): number {
  const respond = vi.fn();
  h({ type: 'STATUS_QUERY', data: {} }, POPUP, respond);
  return (respond.mock.calls[0][0] as { lifetimeStats: { totalSessions: number } }).lifetimeStats.totalSessions;
}

beforeEach(async () => {
  vi.resetModules();
  vi.useFakeTimers();
  await chromeMock.storage.local.clear();
  (chromeMock as unknown as Record<string, unknown>).debugger = undefined;
  delete (chromeMock.tabs as unknown as Record<string, unknown>).get;
});

afterEach(() => {
  vi.useRealTimers();
});

describe('a further detection in a tab continues that tab\'s session', () => {
  it('three detections in one tab are stored as one session that lists each of them', async () => {
    const h = await loadWorker();

    detect(h, 42, 'a1', 'cdp-generic', 'https://shop.example.com/cart');
    await step();
    detect(h, 42, 'a2', 'playwright', 'https://shop.example.com/cart');
    await step();
    detect(h, 42, 'a3', 'playwright', 'https://news.example.org/today');
    await step();

    const sessions = await storedSessions();
    expect(sessions).toHaveLength(1);
    expect(detectionUrls(sessions[0])).toEqual([
      'https://shop.example.com/cart',
      'https://shop.example.com/cart',
      'https://news.example.org/today',
    ]);
    expect(sessions[0].events.filter((e) => e.type === 'detection').map((e) => e.description)).toEqual([
      'Agent detected: CDP Agent',
      'Agent detected: Playwright',
      'Agent detected: Playwright',
    ]);
    // The session names the agent now registered for the tab.
    expect(sessions[0].agent.id).toBe('a3');
    expect(sessions[0].endedAt).toBeNull();
  });

  it('two detections reported for one tab before the first is stored share one session', async () => {
    const h = await loadWorker();

    detect(h, 42, 'a1', 'cdp-generic', 'https://shop.example.com/cart');
    detect(h, 42, 'a2', 'playwright', 'https://shop.example.com/cart');
    await step();

    const sessions = await storedSessions();
    expect(sessions).toHaveLength(1);
    expect(detectionUrls(sessions[0])).toHaveLength(2);
  });

  it('six detections in one tab leave the session of another tab in the store', async () => {
    const h = await loadWorker();

    detect(h, 7, 'other', 'selenium', 'https://bank.example.net/accounts');
    await step();
    for (let i = 1; i <= 6; i++) {
      detect(h, 42, `a${i}`, 'playwright', `https://shop.example.com/page-${i}`);
      await step();
    }

    const sessions = await storedSessions();
    expect(sessions.map((s) => s.agent.originUrl).sort()).toEqual([
      'https://bank.example.net/accounts',
      'https://shop.example.com/page-6',
    ]);
    expect(detectionUrls(sessions.find((s) => s.agent.type === 'playwright')!)).toHaveLength(6);
  });

  it('the violations of a page that was detected twice are written to one session', async () => {
    const h = await loadWorker();
    h({ type: 'DELEGATION_UPDATE', data: createRuleFromPreset('readOnly') }, POPUP, vi.fn());
    await step();

    detect(h, 42, 'a1', 'cdp-generic', 'https://shop.example.com/cart');
    await step();
    await blockTextInput(h, 42, 'https://shop.example.com/cart', 'v1');
    detect(h, 42, 'a2', 'playwright', 'https://shop.example.com/cart');
    await step();
    await blockTextInput(h, 42, 'https://shop.example.com/cart', 'v2');

    const sessions = await storedSessions();
    expect(sessions).toHaveLength(1);
    expect(sessions[0].events.filter((e) => e.type === 'boundary-violation')).toHaveLength(2);
    expect(sessions[0].summary.violations).toBe(2);
  });

  it('counts one session monitored for one tab, however many detections it reports', async () => {
    const h = await loadWorker();

    detect(h, 42, 'a1', 'playwright', 'https://shop.example.com/cart');
    await step();
    detect(h, 42, 'a2', 'playwright', 'https://shop.example.com/checkout');
    await step();
    expect(sessionsMonitored(h)).toBe(1);

    detect(h, 43, 'b1', 'playwright', 'https://news.example.org/today');
    await step();
    expect(sessionsMonitored(h)).toBe(2);
  });
});

describe('a detection starts a new session when the tab has no open stored session', () => {
  it('after the tab closed and its session ended', async () => {
    const h = await loadWorker();

    detect(h, 42, 'a1', 'playwright', 'https://shop.example.com/cart');
    await step();
    await closeTab(42);
    detect(h, 42, 'a2', 'playwright', 'https://shop.example.com/cart');
    await step();

    const sessions = await storedSessions();
    expect(sessions).toHaveLength(2);
    expect(sessions.map((s) => s.endReason)).toEqual([null, 'page-unload']);
    expect(detectionUrls(sessions[1])).toHaveLength(1);
    expect(sessionsMonitored(h)).toBe(2);
  });

  it('after the tab\'s session was pushed out of the store by five later ones', async () => {
    const h = await loadWorker();

    detect(h, 1, 'first', 'selenium', 'https://one.example.com/');
    await step();
    for (let tabId = 2; tabId <= 6; tabId++) {
      detect(h, tabId, `t${tabId}`, 'playwright', `https://site-${tabId}.example.com/`);
      await step();
    }
    expect((await storedSessions()).some((s) => s.agent.id === 'first')).toBe(false);

    detect(h, 1, 'again', 'selenium', 'https://one.example.com/next');
    await step();

    const sessions = await storedSessions();
    expect(sessions).toHaveLength(5);
    expect(sessions[0].agent.id).toBe('again');
    expect(detectionUrls(sessions[0])).toEqual(['https://one.example.com/next']);
  });
});

describe('a tab\'s session keeps a bounded number of detection entries', () => {
  it('30 repeated reports from one page leave one detection entry', async () => {
    const h = await loadWorker();

    // A page reports its agent again every few seconds, each time with a new id.
    for (let i = 1; i <= 30; i++) {
      detect(h, 42, `a${i}`, 'cdp-generic', 'https://shop.example.com/cart');
      await step();
    }

    const sessions = await storedSessions();
    expect(sessions).toHaveLength(1);
    expect(detectionUrls(sessions[0])).toEqual(['https://shop.example.com/cart']);
    // The session still names the agent of the latest report.
    expect(sessions[0].agent.id).toBe('a30');
  });

  it('the same agent on a page it returns to is listed again', async () => {
    const h = await loadWorker();

    detect(h, 42, 'a1', 'playwright', 'https://shop.example.com/cart');
    await step();
    detect(h, 42, 'a2', 'playwright', 'https://shop.example.com/checkout');
    await step();
    detect(h, 42, 'a3', 'playwright', 'https://shop.example.com/cart');
    await step();

    expect(detectionUrls((await storedSessions())[0])).toEqual([
      'https://shop.example.com/cart',
      'https://shop.example.com/checkout',
      'https://shop.example.com/cart',
    ]);
  });

  it('reports from 31 pages leave the 20 most recent detection entries and the session\'s other events', async () => {
    const h = await loadWorker();
    h({ type: 'DELEGATION_UPDATE', data: createRuleFromPreset('readOnly') }, POPUP, vi.fn());
    await step();

    detect(h, 42, 'a0', 'playwright', 'https://shop.example.com/page-0');
    await step();
    await blockTextInput(h, 42, 'https://shop.example.com/page-0', 'v1');
    for (let i = 1; i <= 30; i++) {
      detect(h, 42, `a${i}`, 'playwright', `https://shop.example.com/page-${i}`);
      await step();
    }

    const sessions = await storedSessions();
    expect(sessions).toHaveLength(1);
    expect(detectionUrls(sessions[0])).toEqual(
      Array.from({ length: 20 }, (_, i) => `https://shop.example.com/page-${i + 11}`),
    );
    expect(sessions[0].events.filter((e) => e.type === 'boundary-violation')).toHaveLength(1);
    expect(sessions[0].summary.violations).toBe(1);
  });
});
