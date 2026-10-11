/**
 * A newly detected agent is announced with an OS notification (#103).
 *
 * Before, a detection changed only the amber agent count on the toolbar icon,
 * which Chrome keeps in the Extensions menu until the icon is pinned. An agent
 * that never triggered a block, such as an external CDP client, could drive the
 * browser without the user ever being told. Now each new agent in a tab shows
 * one notification naming the agent type, the site and the kill-switch
 * shortcut, unless notifications are turned off.
 *
 * Driven through the real background worker and the repository's chrome mock.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { chromeMock } from '../__tests__/setup';

type Listener = (msg: unknown, sender: unknown, sendResponse: (r: unknown) => void) => boolean;
type Target = { id: string; type: string; title: string; url: string; attached: boolean; tabId?: number };

const step = (ms = 10) => vi.advanceTimersByTimeAsync(ms);
const TITLE_PREFIX = 'AI Browser Guard - Agent detected';
const DEVTOOLS: Target = { id: 'dt', type: 'other', title: 'DevTools', url: 'devtools://devtools/bundled/devtools_app.html', attached: false };

function page(tabId: number, url: string): Target {
  return { id: `p${tabId}`, type: 'page', title: 'Page', url, attached: true, tabId };
}

function installDebugger(targets: Target[]) {
  (chromeMock as unknown as Record<string, unknown>).debugger = {
    getTargets: (cb: (t: Target[]) => void) => cb(targets),
  };
}

function setShortcut(shortcut: string) {
  (chromeMock.commands as unknown as Record<string, unknown>).getAll = vi.fn(() => Promise.resolve([
    { name: 'kill-switch', shortcut, description: 'Activate emergency kill switch' },
  ]));
}

/** Import the worker; with `settle` false, return before its stored state has loaded. */
async function loadWorker(settle = true): Promise<Listener> {
  const downloads = chromeMock.downloads as unknown as Record<string, unknown>;
  downloads.onCreated = { addListener: vi.fn(), removeListener: vi.fn() };
  chromeMock.runtime.onMessage.addListener.mockClear();
  await import('./index');
  if (settle) await step();
  const calls = chromeMock.runtime.onMessage.addListener.mock.calls;
  return calls[calls.length - 1][0] as Listener;
}

function detect(h: Listener, tabId: number, id: string, type: string, url: string) {
  const agent = { id, type, detectionMethods: ['framework-fingerprint'], confidence: 'confirmed',
    detectedAt: new Date().toISOString(), originUrl: url, observedCapabilities: [], isActive: true };
  const respond = vi.fn();
  h({ type: 'DETECTION_RESULT', data: { id: `det-${id}`, timestamp: new Date().toISOString(),
    methods: ['framework-fingerprint'], confidence: 'confirmed', agent, url, signals: {} } },
  { id: 'test-id', tab: { id: tabId }, frameId: 0, url, origin: new URL(url).origin }, respond);
  return respond;
}

function agentNotices(): Array<{ id: string; title: string; message: string }> {
  return (chromeMock.notifications.create.mock.calls as unknown as Array<[string, { title?: string; message?: string }]>)
    .filter(([, o]) => o?.title?.startsWith(TITLE_PREFIX))
    .map(([id, o]) => ({ id, title: o.title ?? '', message: o.message ?? '' }));
}

function agentCount(h: Listener): number {
  const respond = vi.fn();
  h({ type: 'STATUS_QUERY', data: {} }, { id: 'test-id', url: 'chrome-extension://test-id/dist/popup/index.html' }, respond);
  return (respond.mock.calls[0][0] as { detectedAgents: unknown[] }).detectedAgents.length;
}

beforeEach(async () => {
  vi.resetModules();
  vi.useFakeTimers();
  await chromeMock.storage.local.clear();
  (chromeMock as unknown as Record<string, unknown>).debugger = undefined;
  delete (chromeMock.commands as unknown as Record<string, unknown>).getAll;
  delete (chromeMock.tabs as unknown as Record<string, unknown>).get;
  chromeMock.notifications.create.mockClear();
  setShortcut('Ctrl+Shift+K');
});

afterEach(() => {
  vi.useRealTimers();
});

describe('a newly detected agent is announced with a notification', () => {
  it('names the agent type, the site and the kill-switch shortcut, and offers no buttons', async () => {
    const h = await loadWorker();
    const respond = detect(h, 42, 'a1', 'playwright', 'https://shop.example.com/cart');
    await step();
    expect(respond).toHaveBeenCalledWith({ success: true });

    const notices = agentNotices();
    expect(notices).toHaveLength(1);
    expect(notices[0].title).toBe(`${TITLE_PREFIX}: Playwright`);
    expect(notices[0].message).toBe(
      'Seen in a tab on shop.example.com. To close every tab an agent controls and revoke all delegations, press Ctrl+Shift+K (kill switch).',
    );
    const [, options] = chromeMock.notifications.create.mock.calls.find((c) => c[0] === notices[0].id) as unknown as [string, Record<string, unknown>];
    expect(options.buttons).toBeUndefined();
  });

  it('points to the popup when the kill switch has no shortcut assigned', async () => {
    setShortcut('');
    const h = await loadWorker();
    detect(h, 42, 'a1', 'selenium', 'https://shop.example.com/cart');
    await step();

    const [notice] = agentNotices();
    expect(notice.title).toBe(`${TITLE_PREFIX}: Selenium`);
    expect(notice.message).toBe(
      'Seen in a tab on shop.example.com. To close every tab an agent controls and revoke all delegations, use Kill Switch in the AI Browser Guard popup. You can give it a shortcut at chrome://extensions/shortcuts.',
    );
  });

  it('a re-detection of the same agent type in the same tab, as after a navigation, shows no second notification', async () => {
    const h = await loadWorker();
    detect(h, 42, 'a1', 'playwright', 'https://shop.example.com/cart');
    await step();
    detect(h, 42, 'a2', 'playwright', 'https://shop.example.com/checkout');
    await step();
    expect(agentNotices()).toHaveLength(1);

    // A different agent type in that tab is a new agent.
    await step(60_000);
    detect(h, 42, 'a3', 'selenium', 'https://shop.example.com/checkout');
    await step();
    expect(agentNotices().map((n) => n.title)).toEqual([`${TITLE_PREFIX}: Playwright`, `${TITLE_PREFIX}: Selenium`]);
  });

  it('agents of one type opening more tabs within 10 s share one notification; another type is announced at once', async () => {
    const h = await loadWorker();
    detect(h, 42, 'a1', 'puppeteer', 'https://a.example.com/');
    await step();
    detect(h, 43, 'a2', 'puppeteer', 'https://b.example.com/');
    await step(9_000);
    expect(agentNotices()).toHaveLength(1);

    detect(h, 44, 'a3', 'playwright', 'https://c.example.com/');
    await step();
    expect(agentNotices()).toHaveLength(2);

    // 10 s after the first Puppeteer notification, a new Puppeteer tab is announced.
    await step(1_000);
    detect(h, 45, 'a4', 'puppeteer', 'https://d.example.com/');
    await step();
    expect(agentNotices().map((n) => n.title)).toEqual([
      `${TITLE_PREFIX}: Puppeteer`,
      `${TITLE_PREFIX}: Playwright`,
      `${TITLE_PREFIX}: Puppeteer`,
    ]);
    expect(agentNotices()[2].message).toContain('d.example.com');
  });

  it('an external debugger attachment, which no page block reveals, is announced', async () => {
    installDebugger([page(55, 'https://bank.example.com/accounts')]);
    const h = await loadWorker();
    expect(agentCount(h)).toBe(1);
    const notices = agentNotices();
    expect(notices).toHaveLength(1);
    expect(notices[0].title).toBe(`${TITLE_PREFIX}: CDP Agent`);
    expect(notices[0].message).toContain('bank.example.com');
  });

  it('an attachment seen while DevTools is open is listed but not announced, since it is most likely the user', async () => {
    installDebugger([page(55, 'https://bank.example.com/accounts'), DEVTOOLS]);
    const h = await loadWorker();
    expect(agentCount(h)).toBe(1);
    expect(agentNotices()).toEqual([]);
  });
});

describe('the Notifications setting and worker restarts', () => {
  it('shows nothing when notifications are turned off, including for a detection that wakes the worker', async () => {
    await chromeMock.storage.local.set({ settings: { notificationsEnabled: false } });
    // The content script's message is what starts a stopped worker, so it can
    // arrive before the worker has read the setting.
    const h = await loadWorker(false);
    detect(h, 42, 'a1', 'playwright', 'https://shop.example.com/cart');
    await step();
    detect(h, 43, 'a2', 'selenium', 'https://shop.example.com/cart');
    await step();
    expect(agentCount(h)).toBe(2);
    expect(agentNotices()).toEqual([]);
  });

  it('an agent restored after a worker restart is not announced again when its page reports it', async () => {
    const agent = { id: 'a1', type: 'playwright', detectionMethods: ['framework-fingerprint'], confidence: 'confirmed',
      detectedAt: new Date().toISOString(), originUrl: 'https://shop.example.com/cart', observedCapabilities: [], isActive: true };
    await chromeMock.storage.local.set({ activeAgentRegistry: { '42': { agent, sessionId: 's1' } } });
    (chromeMock.tabs as unknown as Record<string, unknown>).get = vi.fn(() => Promise.resolve({ id: 42, url: 'https://shop.example.com/checkout' }));

    const h = await loadWorker(false);
    detect(h, 42, 'a2', 'playwright', 'https://shop.example.com/checkout');
    await step();
    expect(agentCount(h)).toBe(1);
    expect(agentNotices()).toEqual([]);
  });
});
