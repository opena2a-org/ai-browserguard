/**
 * The agent list follows the browser: an agent seen only through a debugger
 * attachment leaves when that attachment ends, the host a download is matched
 * against follows the agent's tab, and an open DevTools window does not
 * register an agent when a download starts.
 *
 * Before, an agent registered from a debugger attachment stayed registered
 * until its tab closed, even after the driver disconnected or the DevTools
 * window that produced the attachment was closed, and every later download was
 * recorded against it. A download was matched against the host of the page
 * the agent was first seen on, wherever its tab had gone since. And the probe
 * a download runs when no agent is registered registered a DevTools-only
 * attachment as an agent.
 *
 * Driven through the real background worker and the repository's chrome mock,
 * with fake timers so the worker's own 3-second attachment check runs.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { chromeMock } from '../__tests__/setup';
import { createRuleFromPreset } from '../delegation/rules';
import type { DelegationRule } from '../types/delegation';
import type { AgentEvent } from '../types/events';

const POPUP_SENDER = { id: 'test-id', url: 'chrome-extension://test-id/dist/popup/index.html' };
type Listener = (msg: unknown, sender: unknown, sendResponse: (r: unknown) => void) => boolean;
type EventMock = { addListener: ReturnType<typeof vi.fn>; _fire: (...args: unknown[]) => void };
type Target = { id: string; type: string; title: string; url: string; attached: boolean; tabId?: number };
type StoredSession = { id: string; agent: { id: string }; events: AgentEvent[]; endedAt: string | null; endReason: string | null };

/** The worker polls the target list every 3 s; the grace before a drop is 5 s. */
const CHECK_MS = 3_000;
const step = (ms = 10) => vi.advanceTimersByTimeAsync(ms);

function eventMock(): EventMock {
  const listeners: Array<(...args: unknown[]) => void> = [];
  return {
    addListener: vi.fn((fn: (...args: unknown[]) => void) => { listeners.push(fn); }),
    _fire: (...args: unknown[]) => { for (const fn of listeners) fn(...args); },
  };
}

function page(tabId: number, url: string, attached: boolean): Target {
  return { id: `p${tabId}`, type: 'page', title: 'Page', url, attached, tabId };
}
const DEVTOOLS: Target = { id: 'dt', type: 'other', title: 'DevTools', url: 'devtools://devtools/bundled/devtools_app.html', attached: false };

let targets: Target[] = [];
let failTargetQuery = false;

/** chrome.debugger reading `targets`; `extra` adds the calls a debugger session needs. */
function installDebugger(extra: Record<string, unknown> = {}) {
  (chromeMock as unknown as Record<string, unknown>).debugger = {
    getTargets: (cb: (t: Target[]) => void) => {
      if (failTargetQuery) {
        chromeMock.runtime.lastError = { message: 'target list unavailable' };
        cb([]);
        chromeMock.runtime.lastError = null;
        return;
      }
      cb(targets);
    },
    ...extra,
  };
}

let onUpdated: EventMock;

async function loadWorker() {
  const downloads = chromeMock.downloads as unknown as Record<string, unknown>;
  downloads.onCreated = { addListener: vi.fn(), removeListener: vi.fn() };
  const cancel = vi.fn((_id: number, cb?: () => void) => { cb?.(); });
  downloads.cancel = cancel;
  const tabs = chromeMock.tabs as unknown as Record<string, unknown>;
  onUpdated = eventMock();
  tabs.onUpdated = onUpdated;
  tabs.onRemoved = eventMock();
  tabs.onReplaced = eventMock();
  chromeMock.runtime.onMessage.addListener.mockClear();
  await import('./index');
  await step();
  const calls = chromeMock.runtime.onMessage.addListener.mock.calls;
  const handleMessage = calls[calls.length - 1][0] as Listener;
  const onCreated = (downloads.onCreated as { addListener: { mock: { calls: unknown[][] } } })
    .addListener.mock.calls[0][0] as (item: unknown) => void;
  return { handleMessage, onCreated, cancel };
}
type Worker = Awaited<ReturnType<typeof loadWorker>>;

function send(h: Listener, type: string, data: unknown, sender: unknown = POPUP_SENDER) {
  const respond = vi.fn();
  h({ type, data }, sender, respond);
  return respond;
}

function agents(w: Worker): Array<{ id: string; originUrl: string }> {
  return (send(w.handleMessage, 'STATUS_QUERY', {}).mock.calls[0][0] as { detectedAgents: Array<{ id: string; originUrl: string }> })
    .detectedAgents;
}

async function sessions(): Promise<StoredSession[]> {
  const { sessions: stored } = (await chromeMock.storage.local.get('sessions')) as { sessions?: StoredSession[] };
  return stored ?? [];
}

async function registry(): Promise<Record<string, unknown>> {
  const { activeAgentRegistry } = (await chromeMock.storage.local.get('activeAgentRegistry')) as {
    activeAgentRegistry?: Record<string, unknown>;
  };
  return activeAgentRegistry ?? {};
}

async function downloadEvents(): Promise<AgentEvent[]> {
  return (await sessions()).flatMap((s) => s.events).filter((e) => e.type === 'download');
}

/** An agent reported by the content script of tab `tabId`. */
async function pageAgent(w: Worker, tabId: number, id: string, methods: string[], url: string) {
  const agent = { id, type: 'cdp-generic', detectionMethods: methods, confidence: 'high',
    detectedAt: new Date().toISOString(), originUrl: url, observedCapabilities: [], isActive: true };
  const respond = send(w.handleMessage, 'DETECTION_RESULT',
    { id: `det-${id}`, timestamp: new Date().toISOString(), methods, confidence: 'high', agent, url, signals: {} },
    { id: 'test-id', tab: { id: tabId }, frameId: 0, url, origin: new URL(url).origin });
  await step();
  expect(respond).toHaveBeenCalledWith(expect.objectContaining({ success: true }));
}

beforeEach(async () => {
  vi.resetModules();
  vi.useFakeTimers();
  await chromeMock.storage.local.clear();
  (chromeMock as unknown as Record<string, unknown>).debugger = undefined;
  targets = [];
  failTargetQuery = false;
});

afterEach(() => {
  vi.useRealTimers();
});

describe('an agent seen only through a debugger attachment leaves when the attachment ends', () => {
  it('a closed DevTools window or a disconnected driver ends the session, and a later download is not recorded against it', async () => {
    targets = [page(55, 'https://app.example.com/dashboard', true)];
    installDebugger();
    const w = await loadWorker();
    expect(agents(w)).toHaveLength(1);
    send(w.handleMessage, 'DELEGATION_UPDATE', createRuleFromPreset('readOnly', { agentId: agents(w)[0].id }));
    await step();

    targets = [page(55, 'https://app.example.com/dashboard', false)];
    await step(CHECK_MS);
    // One check without the attachment is not enough.
    expect(agents(w)).toHaveLength(1);
    await step(2 * CHECK_MS);
    expect(agents(w)).toEqual([]);

    const [session] = await sessions();
    expect(session.endReason).toBe('agent-disconnected');
    expect(session.endedAt).not.toBeNull();
    expect(await registry()).toEqual({});
    // The Read-Only granted to that agent no longer applies to its tab.
    const toTab = (chromeMock.tabs.sendMessage.mock.calls as unknown as unknown[][]).filter((c) => c[0] === 55);
    expect(toTab[toTab.length - 1][1]).toMatchObject({ type: 'DELEGATION_UPDATE', data: null });

    w.onCreated({ id: 1, url: 'https://app.example.com/report.pdf', referrer: 'https://app.example.com/dashboard' });
    await step();
    expect(await downloadEvents()).toEqual([]);
  });

  it('an attachment that comes back before the grace runs out keeps the agent and its session', async () => {
    targets = [page(55, 'https://app.example.com/dashboard', true)];
    installDebugger();
    const w = await loadWorker();
    targets = [page(55, 'https://app.example.com/dashboard', false)];
    await step(CHECK_MS);
    targets = [page(55, 'https://app.example.com/dashboard', true)];
    await step(CHECK_MS);
    targets = [page(55, 'https://app.example.com/dashboard', false)];
    await step(CHECK_MS);
    expect(agents(w)).toHaveLength(1);
    expect((await sessions()).map((s) => s.endedAt)).toEqual([null]);
  });

  it('an agent its page reported stays, even with no debugger attached anywhere', async () => {
    installDebugger();
    const w = await loadWorker();
    // The in-page CDP pattern check reports 'cdp-connection' as well.
    await pageAgent(w, 42, 'a-page', ['cdp-connection'], 'https://mail.example.com/inbox');
    await step(4 * CHECK_MS);
    expect(agents(w).map((a) => a.id)).toEqual(['a-page']);
  });

  it('a target list that cannot be read drops nothing', async () => {
    targets = [page(55, 'https://app.example.com/dashboard', true)];
    installDebugger();
    const w = await loadWorker();
    failTargetQuery = true;
    await step(4 * CHECK_MS);
    expect(agents(w)).toHaveLength(1);
  });

  it('a tab holding our own blocking session keeps its agent: that session hides whether the driver is still attached', async () => {
    targets = [page(55, 'https://app.example.com/dashboard', true)];
    const sendCommand = vi.fn(() => Promise.resolve({}));
    installDebugger({
      attach: vi.fn(() => Promise.resolve()),
      detach: vi.fn(() => Promise.resolve()),
      sendCommand,
      onEvent: eventMock(),
      onDetach: eventMock(),
    });
    const w = await loadWorker();
    send(w.handleMessage, 'SETTINGS_UPDATE', { cdpEnforcementEnabled: true });
    await step();
    const rule: DelegationRule = createRuleFromPreset('readOnly');
    send(w.handleMessage, 'DELEGATION_UPDATE',
      { ...rule, scope: { ...rule.scope, sitePatterns: [{ pattern: 'blocked.example', action: 'block' }] } });
    await step();
    expect(sendCommand).toHaveBeenCalledWith({ tabId: 55 }, 'Page.enable', {});

    // Chrome would report the tab attached while our session holds it; even a
    // read that says otherwise must not drop the agent.
    targets = [page(55, 'https://app.example.com/dashboard', false)];
    await step(4 * CHECK_MS);
    expect(agents(w)).toHaveLength(1);
  });

  it('after a worker restart, a restored debugger agent still leaves when its attachment is gone; a page-reported one stays', async () => {
    const now = new Date().toISOString();
    const stored = (id: string, url: string) => ({
      id: `s-${id}`,
      agent: { id, type: 'cdp-generic', detectionMethods: ['cdp-connection'], confidence: 'high',
        detectedAt: now, originUrl: url, observedCapabilities: [], isActive: true },
      delegationRule: null, events: [], startedAt: now, endedAt: null, endReason: null,
      summary: { totalActions: 0, allowedActions: 0, blockedActions: 0, violations: 0, topUrls: [], durationSeconds: null },
    });
    const viaDebugger = stored('a-debugger', 'https://app.example.com/dashboard');
    const viaPage = stored('a-page', 'https://mail.example.com/inbox');
    await chromeMock.storage.local.set({
      sessions: [viaDebugger, viaPage],
      activeAgentRegistry: {
        55: { agent: viaDebugger.agent, sessionId: viaDebugger.id, fromDebugger: true },
        56: { agent: viaPage.agent, sessionId: viaPage.id },
      },
    });
    (chromeMock.tabs as unknown as Record<string, unknown>).get = vi.fn((id: number) =>
      Promise.resolve({ id, url: id === 55 ? 'https://app.example.com/dashboard' : 'https://mail.example.com/inbox' }));
    installDebugger();
    const w = await loadWorker();
    expect(agents(w).map((a) => a.id).sort()).toEqual(['a-debugger', 'a-page']);

    await step(3 * CHECK_MS);
    expect(agents(w).map((a) => a.id)).toEqual(['a-page']);
    const byId = new Map((await sessions()).map((s) => [s.id, s]));
    expect(byId.get('s-a-debugger')?.endReason).toBe('agent-disconnected');
    expect(byId.get('s-a-page')?.endedAt).toBeNull();
    expect(Object.keys(await registry())).toEqual(['56']);
  });
});

describe("the host a download is matched against follows the agent's tab", () => {
  it("after the agent's tab navigates, its new site is the host match and its old site is not", async () => {
    const w = await loadWorker();
    await pageAgent(w, 42, 'a-page', ['synthetic-event'], 'https://a.example.com/start');
    onUpdated._fire(42, { url: 'https://b.example.com/app' }, { id: 42 });
    await step();

    w.onCreated({ id: 1, url: 'https://b.example.com/export.zip', referrer: 'https://b.example.com/app' });
    await step();
    w.onCreated({ id: 2, url: 'https://a.example.com/my-own-file.pdf', referrer: 'https://a.example.com/home' });
    await step();
    expect((await downloadEvents()).map((e) => e.attribution)).toEqual([
      { level: 'host', matchedHost: 'b.example.com' },
      { level: 'none' },
    ]);
  });

  it('a page with no origin in the agent tab matches no host', async () => {
    const w = await loadWorker();
    await pageAgent(w, 42, 'a-page', ['synthetic-event'], 'https://a.example.com/start');
    onUpdated._fire(42, { url: 'about:blank' }, { id: 42 });
    await step();
    w.onCreated({ id: 1, url: 'https://a.example.com/file.pdf', referrer: 'https://a.example.com/start' });
    await step();
    expect((await downloadEvents()).map((e) => e.attribution)).toEqual([{ level: 'none' }]);
  });

  it("a debugger agent's host follows its page target's URL", async () => {
    targets = [page(55, 'https://a.example.com/start', true)];
    installDebugger();
    const w = await loadWorker();
    targets = [page(55, 'https://b.example.com/app', true)];
    await step(CHECK_MS);
    w.onCreated({ id: 1, url: 'https://b.example.com/export.zip', referrer: 'https://b.example.com/app' });
    await step();
    expect((await downloadEvents()).map((e) => e.attribution)).toEqual([{ level: 'host', matchedHost: 'b.example.com' }]);
  });
});

describe('the download-time probe and an open DevTools window', () => {
  it('a DevTools-only attachment registers no agent when a download starts, and the download is not recorded', async () => {
    installDebugger();
    const w = await loadWorker();
    targets = [page(55, 'https://app.example.com/dashboard', true), DEVTOOLS];
    w.onCreated({ id: 1, url: 'https://app.example.com/report.pdf', referrer: 'https://app.example.com/dashboard' });
    await step();
    expect(agents(w)).toEqual([]);
    expect(await sessions()).toEqual([]);
  });

  it('an attachment with no DevTools open still registers its tab when a download starts', async () => {
    installDebugger();
    const w = await loadWorker();
    targets = [page(55, 'https://app.example.com/dashboard', true)];
    w.onCreated({ id: 1, url: 'https://app.example.com/report.pdf', referrer: 'https://app.example.com/dashboard' });
    await step();
    expect(agents(w)).toHaveLength(1);
    expect((await downloadEvents()).map((e) => e.attribution)).toEqual([{ level: 'host', matchedHost: 'app.example.com' }]);
  });
});
