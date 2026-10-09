/**
 * A download is cancelled only when Chrome reports it starting in an agent's
 * tab, on a debugger session this extension holds there.
 *
 * Before, under a delegation that does not permit downloads, a download whose
 * referrer, final URL or URL had the same host name as the page an agent was
 * first seen on was cancelled, whoever started it. A chrome.downloads item
 * carries no tab id, so the user's own download in another tab of that site, a
 * link to the agent's host from another site, a download from another port of
 * the same host, and a host registered by an open DevTools window were all
 * cancelled with no way back. Each case below cancelled on the code before
 * this change; each is now recorded as a host match or as uncertain.
 *
 * Driven through the real background worker and the repository's chrome mock.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { chromeMock } from '../__tests__/setup';
import { createRuleFromPreset } from '../delegation/rules';
import { TAB_DOWNLOAD_START_WINDOW_MS } from './download-monitor';
import { TAB_DOWNLOAD_START_GRACE_MS } from './cdp-enforcement';
import { withBlockedSite } from '../__tests__/download-tab-watch';
import type { DelegationRule } from '../types/delegation';
import type { AgentEvent } from '../types/events';

const POPUP_SENDER = { id: 'test-id', url: 'chrome-extension://test-id/dist/popup/index.html' };
type Listener = (msg: unknown, sender: unknown, sendResponse: (r: unknown) => void) => boolean;
type EventMock = { addListener: ReturnType<typeof vi.fn>; _fire: (...args: unknown[]) => void };

const flush = () => new Promise<void>((r) => setTimeout(r, 0));
async function settle(n = 10): Promise<void> {
  for (let i = 0; i < n; i++) await flush();
}

function eventMock(): EventMock {
  const listeners: Array<(...args: unknown[]) => void> = [];
  return {
    addListener: vi.fn((fn: (...args: unknown[]) => void) => { listeners.push(fn); }),
    _fire: (...args: unknown[]) => { for (const fn of listeners) fn(...args); },
  };
}

function detection(agentId: string, type: string, methods: string[], originUrl: string) {
  return {
    id: `det-${agentId}`, timestamp: new Date().toISOString(), methods, confidence: 'high',
    agent: { id: agentId, type, detectionMethods: methods, confidence: 'high',
      detectedAt: new Date().toISOString(), originUrl, observedCapabilities: [], isActive: true },
    url: originUrl, signals: {},
  };
}

function contentSender(tabId: number, url: string) {
  let origin = 'null';
  try { origin = new URL(url).origin; } catch { /* opaque */ }
  return { id: 'test-id', tab: { id: tabId }, frameId: 0, url, origin };
}

/** chrome.debugger with getTargets only: detection works, no session can be attached. */
function setTargets(targets: unknown[]) {
  (chromeMock as unknown as Record<string, unknown>).debugger = {
    getTargets: (cb: (t: unknown[]) => void) => cb(targets),
  };
}

async function loadWorker() {
  const downloads = chromeMock.downloads as unknown as Record<string, unknown>;
  downloads.onCreated = { addListener: vi.fn(), removeListener: vi.fn() };
  const cancel = vi.fn((_id: number, cb?: () => void) => { cb?.(); });
  downloads.cancel = cancel;
  const pause = vi.fn((_id: number, cb?: () => void) => { cb?.(); });
  downloads.pause = pause;
  (chromeMock.tabs as unknown as Record<string, unknown>).remove = vi.fn(() => Promise.resolve());
  chromeMock.notifications.create.mockClear();
  chromeMock.runtime.onMessage.addListener.mockClear();
  await import('./index');
  const calls = chromeMock.runtime.onMessage.addListener.mock.calls;
  const handleMessage = calls[calls.length - 1][0] as Listener;
  const onCreated = (downloads.onCreated as { addListener: { mock: { calls: unknown[][] } } })
    .addListener.mock.calls[0][0] as (item: unknown) => void;
  return { handleMessage, onCreated, cancel, pause };
}
type Worker = Awaited<ReturnType<typeof loadWorker>>;

function send(h: Listener, type: string, data: unknown, sender: unknown = POPUP_SENDER) {
  const respond = vi.fn();
  h({ type, data }, sender, respond);
  return respond;
}

async function agent(w: Worker, tabId: number, id: string, type: string, methods: string[], url: string) {
  const r = send(w.handleMessage, 'DETECTION_RESULT', detection(id, type, methods, url), contentSender(tabId, url));
  await settle(4);
  expect(r).toHaveBeenCalledWith(expect.objectContaining({ success: true }));
}

async function grant(w: Worker, rule: unknown) {
  send(w.handleMessage, 'DELEGATION_UPDATE', rule);
  await settle(4);
}

function status(w: Worker) {
  return send(w.handleMessage, 'STATUS_QUERY', {}).mock.calls[0][0] as {
    recentViolations: Array<{ title: string }>;
    lifetimeStats: { totalActionsBlocked: number };
    downloadWatchedAgentIds: string[];
    detectedAgents: Array<{ id: string; confidence: string }>;
  };
}

async function downloadEvents(): Promise<AgentEvent[]> {
  const { sessions } = (await chromeMock.storage.local.get('sessions')) as { sessions?: Array<{ events: AgentEvent[] }> };
  return (sessions ?? []).flatMap((s) => s.events).filter((e) => e.type === 'download');
}

function cancelledIds(w: Worker): unknown[] {
  return w.cancel.mock.calls.map((c: unknown[]) => c[0]);
}

beforeEach(async () => {
  vi.resetModules();
  await chromeMock.storage.local.clear();
  (chromeMock as unknown as Record<string, unknown>).debugger = undefined;
});

describe('a host match alone no longer cancels the download', () => {
  it("in-page agent under a per-agent Read-Only: the user's same-site download in another tab, and its retry, complete", async () => {
    const w = await loadWorker();
    await agent(w, 42, 'a-inpage', 'unknown', ['synthetic-event'], 'https://mail.example.com/inbox');
    await grant(w, createRuleFromPreset('readOnly', { agentId: 'a-inpage' }));
    const item = { url: 'https://mail.example.com/attachment/123', finalUrl: 'https://mail.example.com/attachment/123',
      referrer: 'https://mail.example.com/inbox/thread-9', filename: '/home/user/Downloads/invoice.pdf' };
    w.onCreated({ id: 101, ...item }); await settle();
    w.onCreated({ id: 102, ...item }); await settle();

    expect(w.cancel).not.toHaveBeenCalled();
    const st = status(w);
    expect(st.recentViolations.some((a) => a.title === 'Download blocked')).toBe(false);
    expect(st.lifetimeStats.totalActionsBlocked).toBe(0);
    const events = await downloadEvents();
    expect(events).toHaveLength(2);
    for (const e of events) {
      expect(e.outcome).toBe('informational');
      expect(e.attribution).toEqual({ level: 'host', matchedHost: 'mail.example.com' });
      expect(e.description).toBe("Download from the agent's host (mail.example.com), tab unknown: invoice.pdf");
    }
  });

  it('external CDP agent under a per-agent Read-Only: a download from another site that links to the agent host completes', async () => {
    const w = await loadWorker();
    await agent(w, 42, 'a-cdp', 'cdp-generic', ['cdp-connection'], 'https://github.com/org/repo/issues');
    await grant(w, createRuleFromPreset('readOnly', { agentId: 'a-cdp' }));
    w.onCreated({ id: 102, url: 'https://github.com/org/repo/releases/download/v1/tool.zip',
      referrer: 'https://news.example.org/post/1', filename: '/home/user/Downloads/tool.zip' });
    await settle();
    expect(w.cancel).not.toHaveBeenCalled();
  });

  it('a download from another port of the agent host is not even a host match', async () => {
    const w = await loadWorker();
    await agent(w, 42, 'a-pw', 'playwright', ['cdp-connection'], 'http://localhost:3000/app');
    await grant(w, createRuleFromPreset('readOnly', { agentId: 'a-pw' }));
    w.onCreated({ id: 301, url: 'http://localhost:8080/export.csv', referrer: 'http://localhost:8080/', filename: '/home/user/Downloads/export.csv' });
    await settle();
    expect(w.cancel).not.toHaveBeenCalled();
    expect((await downloadEvents()).map((e) => e.attribution)).toEqual([{ level: 'none' }]);
  });

  it('with DevTools open on the user tab and a session-wide Read-Only, the download completes, and so does a later one after DevTools closes', async () => {
    const w = await loadWorker();
    await grant(w, createRuleFromPreset('readOnly'));
    setTargets([
      { id: 'p1', type: 'page', title: 'Dashboard', url: 'https://app.example.com/dashboard', attached: true, tabId: 55 },
      { id: 'dt', type: 'other', title: 'DevTools', url: 'devtools://devtools/bundled/devtools_app.html', attached: false },
    ]);
    w.onCreated({ id: 1, url: 'https://app.example.com/report.pdf', referrer: 'https://app.example.com/dashboard' });
    await settle(14);
    setTargets([{ id: 'p1', type: 'page', title: 'Dashboard', url: 'https://app.example.com/dashboard', attached: false, tabId: 55 }]);
    w.onCreated({ id: 2, url: 'https://app.example.com/b.pdf', referrer: 'https://app.example.com/settings' });
    await settle(14);
    expect(w.cancel).not.toHaveBeenCalled();
  });

  it('a CDP agent registered on one site that moved to another: neither the user download on the first site nor an unreported one on the second is cancelled', async () => {
    const w = await loadWorker();
    await grant(w, createRuleFromPreset('readOnly'));
    setTargets([{ id: 'p1', type: 'page', title: 'A', url: 'https://a.example.com/start', attached: true, tabId: 55 }]);
    w.onCreated({ id: 10, url: 'https://unrelated.example.net/x.bin', referrer: 'https://unrelated.example.net/' }); await settle(14);
    setTargets([{ id: 'p1', type: 'page', title: 'B', url: 'https://b.example.com/app', attached: true, tabId: 55 }]);
    w.onCreated({ id: 11, url: 'https://b.example.com/export.zip', referrer: 'https://b.example.com/app' }); await settle(14);
    w.onCreated({ id: 12, url: 'https://a.example.com/my-own-file.pdf', referrer: 'https://a.example.com/home' }); await settle(14);
    expect(cancelledIds(w)).toEqual([]);
  });

  it('a card Read-Only grant, then a session-wide Full Access: the same-site download completes', async () => {
    const w = await loadWorker();
    await agent(w, 42, 'a1', 'cdp-generic', ['cdp-connection'], 'https://mail.example.com/inbox');
    await grant(w, createRuleFromPreset('readOnly', { agentId: 'a1' }));
    await grant(w, createRuleFromPreset('fullAccess'));
    w.onCreated({ id: 1301, url: 'https://mail.example.com/attachment/1', referrer: 'https://mail.example.com/inbox' });
    await settle();
    expect(w.cancel).not.toHaveBeenCalled();
  });
});

/**
 * A host match is never held. Pausing it and cancelling it unless the user
 * kept it was measured on Chrome 145 (scripts/measure-download-hold.mjs): a
 * short-lived URL without range support is lost on resume once the server
 * closes the idle connection, and a blob: download ignores the pause. Under a
 * delegation that blocks downloads the user is told it was left to finish.
 */
describe('a host match under a delegation that blocks downloads is left to finish, with a notice', () => {
  const item = { url: 'https://mail.example.com/attachment/123', referrer: 'https://mail.example.com/inbox', filename: '/home/user/Downloads/invoice.pdf' };
  const NOTICE_TITLE = 'AI Browser Guard - Download not stopped';

  function notices() {
    return chromeMock.notifications.create.mock.calls
      .map((c: unknown[]) => c[1] as { title?: string; message?: string; buttons?: unknown[] })
      .filter((o) => o.title === NOTICE_TITLE);
  }

  async function inPageAgentUnder(rule: DelegationRule | null): Promise<Worker> {
    const w = await loadWorker();
    await agent(w, 42, 'a-inpage', 'unknown', ['synthetic-event'], 'https://mail.example.com/inbox');
    if (rule) await grant(w, rule);
    return w;
  }

  it('neither pauses nor cancels it, shows one notice with no buttons, and lists or counts no block', async () => {
    const w = await inPageAgentUnder(createRuleFromPreset('readOnly', { agentId: 'a-inpage' }));
    w.onCreated({ id: 101, ...item }); await settle();

    expect(w.pause).not.toHaveBeenCalled();
    expect(w.cancel).not.toHaveBeenCalled();
    const shown = notices();
    expect(shown).toHaveLength(1);
    expect(shown[0].buttons).toBeUndefined();
    expect(shown[0].message).toBe(
      "Did not stop a download: invoice.pdf. It is from mail.example.com, where an agent was detected, but it was not seen starting in the agent's tab, so it may be yours. Your delegation (Read-Only) stops only downloads seen starting in that tab. It is listed on the Timeline in the popup.",
    );
    const blockTitles = chromeMock.notifications.create.mock.calls
      .map((c: unknown[]) => (c[1] as { title?: string }).title ?? '')
      .filter((t: string) => t.includes('Download blocked'));
    expect(blockTitles).toEqual([]);
    const st = status(w);
    expect(st.recentViolations).toEqual([]);
    expect(st.lifetimeStats.totalActionsBlocked).toBe(0);
    expect((await downloadEvents()).map((e) => e.outcome)).toEqual(['informational']);
  });

  it('a burst of same-site downloads gives one notice and records each download', async () => {
    const w = await inPageAgentUnder(createRuleFromPreset('readOnly'));
    w.onCreated({ id: 201, ...item }); await settle();
    w.onCreated({ id: 202, ...item }); await settle();
    w.onCreated({ id: 203, ...item }); await settle();

    expect(notices()).toHaveLength(1);
    expect(await downloadEvents()).toHaveLength(3);
    expect(w.pause).not.toHaveBeenCalled();
    expect(w.cancel).not.toHaveBeenCalled();
  });

  it('shows no notice with notifications turned off, and still records the download', async () => {
    const w = await inPageAgentUnder(createRuleFromPreset('readOnly', { agentId: 'a-inpage' }));
    send(w.handleMessage, 'SETTINGS_UPDATE', { notificationsEnabled: false });
    await settle(4);
    w.onCreated({ id: 301, ...item }); await settle();

    expect(notices()).toHaveLength(0);
    expect((await downloadEvents()).map((e) => e.attribution?.level)).toEqual(['host']);
  });

  it('shows no notice under a delegation that permits downloads', async () => {
    const w = await inPageAgentUnder(createRuleFromPreset('fullAccess', { agentId: 'a-inpage' }));
    w.onCreated({ id: 401, ...item }); await settle();
    expect(notices()).toHaveLength(0);
  });

  it('shows no notice with no delegation', async () => {
    const w = await inPageAgentUnder(null);
    w.onCreated({ id: 501, ...item }); await settle();
    expect(notices()).toHaveLength(0);
  });

  it('shows no notice for a download that matches no agent page', async () => {
    const w = await inPageAgentUnder(createRuleFromPreset('readOnly', { agentId: 'a-inpage' }));
    w.onCreated({ id: 601, url: 'https://mail.example.com:8443/export.csv', referrer: 'https://other.example.org/', filename: '/home/user/Downloads/export.csv' });
    await settle();
    expect((await downloadEvents()).map((e) => e.attribution)).toEqual([{ level: 'none' }]);
    expect(notices()).toHaveLength(0);
  });
});

describe('outcomes that already let the download through are unchanged', () => {
  const item = { url: 'https://mail.example.com/attachment/123', referrer: 'https://mail.example.com/inbox', filename: '/home/user/Downloads/invoice.pdf' };

  it('Revoke on the agent card', async () => {
    const w = await loadWorker();
    await agent(w, 42, 'a-inpage', 'unknown', ['synthetic-event'], 'https://mail.example.com/inbox');
    const ro = createRuleFromPreset('readOnly', { agentId: 'a-inpage' });
    await grant(w, ro);
    await grant(w, { ...ro, isActive: false });
    w.onCreated({ id: 501, ...item }); await settle();
    expect(w.cancel).not.toHaveBeenCalled();
  });

  it('the kill switch', async () => {
    const w = await loadWorker();
    await agent(w, 42, 'a-inpage', 'unknown', ['synthetic-event'], 'https://mail.example.com/inbox');
    await grant(w, createRuleFromPreset('readOnly'));
    send(w.handleMessage, 'KILL_SWITCH_ACTIVATE', { trigger: 'button' });
    await settle(20);
    w.onCreated({ id: 801, ...item }); await settle();
    expect(w.cancel).not.toHaveBeenCalled();
  });

  it('a per-agent Full Access', async () => {
    const w = await loadWorker();
    await agent(w, 42, 'a-inpage', 'unknown', ['synthetic-event'], 'https://mail.example.com/inbox');
    await grant(w, createRuleFromPreset('fullAccess', { agentId: 'a-inpage' }));
    w.onCreated({ id: 901, ...item }); await settle();
    expect(w.cancel).not.toHaveBeenCalled();
  });

  it('no rule at all', async () => {
    const w = await loadWorker();
    await agent(w, 42, 'a-cdp', 'cdp-generic', ['cdp-connection'], 'https://mail.example.com/inbox');
    w.onCreated({ id: 1001, ...item }); await settle();
    expect(w.cancel).not.toHaveBeenCalled();
  });
});

describe('a download Chrome reports starting in the agent tab is cancelled', () => {
  let onEvent: EventMock;
  let onRemoved: EventMock;
  let sendCommand: ReturnType<typeof vi.fn>;

  /** A Read-Only delegation with a blocked site, so Browser-layer blocking attaches to the agent tab. */
  function readOnlyWithBlockedSite(): DelegationRule {
    const rule = createRuleFromPreset('readOnly');
    return { ...rule, scope: { ...rule.scope, sitePatterns: [{ pattern: 'blocked.example', action: 'block' }] } };
  }

  /** Let every pending handler, including a download waiting for its start report, finish. */
  async function drain(): Promise<void> {
    await vi.advanceTimersByTimeAsync(TAB_DOWNLOAD_START_WINDOW_MS + 10);
  }

  function willBegin(tabId: number, guid: string, url: string) {
    onEvent._fire({ tabId }, 'Page.downloadWillBegin', { frameId: `frame-${tabId}`, guid, url, suggestedFilename: 'x' });
  }

  /** The target list the worker reads; tests that open DevTools replace it. */
  let targets: unknown[];

  /**
   * The built-in DevTools front end as Chrome 145 lists it to an extension:
   * an unattached page with no tab id. The page it inspects reports an
   * attachment, exactly as it would under an external client.
   */
  const DEVTOOLS_FRONT_END = {
    id: 'dt', type: 'page', title: 'DevTools', attached: false,
    url: 'devtools://devtools/bundled/devtools_app.html?remoteBase=https://chrome-devtools-frontend.appspot.com/',
  };

  /** A CDP agent first seen on about:blank in tab 55, our session attached to that tab. */
  async function watchedAgentTab(
    rule: DelegationRule,
    initialTargets: unknown[] = [{ id: 'p1', type: 'page', title: 'A', url: 'about:blank', attached: true, tabId: 55 }],
  ): Promise<Worker> {
    vi.useFakeTimers();
    onEvent = eventMock();
    sendCommand = vi.fn(() => Promise.resolve({}));
    targets = initialTargets;
    (chromeMock as unknown as Record<string, unknown>).debugger = {
      attach: vi.fn(() => Promise.resolve()),
      detach: vi.fn(() => Promise.resolve()),
      sendCommand,
      onEvent,
      onDetach: eventMock(),
      getTargets: (cb: (t: unknown[]) => void) => cb(targets),
    };
    onRemoved = eventMock();
    const tabs = chromeMock.tabs as unknown as Record<string, unknown>;
    tabs.onRemoved = onRemoved;
    const w = await loadWorker();
    send(w.handleMessage, 'SETTINGS_UPDATE', { cdpEnforcementEnabled: true });
    await drain();
    send(w.handleMessage, 'DELEGATION_UPDATE', rule);
    await drain();
    // The first download probes for the debugger attachment and registers the
    // driver on tab 55; the delegation then attaches our session there.
    w.onCreated({ id: 10, url: 'https://unrelated.example.net/x.bin', referrer: 'https://unrelated.example.net/' });
    await drain();
    expect(sendCommand).toHaveBeenCalledWith({ tabId: 55 }, 'Page.enable', {});
    return w;
  }

  afterEach(() => {
    vi.useRealTimers();
  });

  it('cancels the reported download, records it as tab-level, and leaves an unreported one alone', async () => {
    const w = await watchedAgentTab(readOnlyWithBlockedSite());
    expect(status(w).downloadWatchedAgentIds).toHaveLength(1);

    willBegin(55, 'g-11', 'https://b.example.com/export.zip');
    w.onCreated({ id: 11, url: 'https://b.example.com/export.zip', referrer: 'https://b.example.com/app', filename: '/d/export.zip' });
    await drain();
    w.onCreated({ id: 12, url: 'https://c.example.org/x.pdf', referrer: 'https://c.example.org/' });
    await drain();

    expect(cancelledIds(w)).toEqual([11]);
    const events = await downloadEvents();
    const blocked = events.find((e) => e.url === 'https://b.example.com/export.zip');
    expect(blocked?.outcome).toBe('blocked');
    expect(blocked?.attribution).toEqual({ level: 'tab', tabId: 55, frameId: 'frame-55' });
    expect(blocked?.description).toBe("Blocked download started in the agent's tab: export.zip");
    expect(events.find((e) => e.url === 'https://c.example.org/x.pdf')?.attribution).toEqual({ level: 'none' });
    const st = status(w);
    expect(st.lifetimeStats.totalActionsBlocked).toBe(1);
    expect(chromeMock.notifications.create).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        title: expect.stringContaining('Download blocked'),
        message: "Cancelled a download: export.zip. It started in a tab where an agent was detected, and your delegation (Read-Only) blocks downloads in that tab, yours included. To get it, close that agent's tab, then retry.",
      }),
    );
  });

  // #91: a download no session reports used to wait out the whole matching
  // window, so its timeline entry and notice came about 5 s late.
  it("records the user's download from another tab of the agent's site, with its notice, without waiting out the window", async () => {
    const w = await watchedAgentTab(readOnlyWithBlockedSite(), [
      { id: 'p1', type: 'page', title: 'App', url: 'https://b.example.com/app', attached: true, tabId: 55 },
    ]);
    expect(status(w).downloadWatchedAgentIds).toHaveLength(1);

    w.onCreated({ id: 81, url: 'https://b.example.com/mine.pdf', referrer: 'https://b.example.com/home', filename: '/d/mine.pdf' });
    await vi.advanceTimersByTimeAsync(TAB_DOWNLOAD_START_GRACE_MS + 10);

    const e = (await downloadEvents()).find((ev) => ev.url === 'https://b.example.com/mine.pdf');
    expect(e?.attribution).toEqual({ level: 'host', matchedHost: 'b.example.com' });
    expect(e?.outcome).toBe('informational');
    const titles = chromeMock.notifications.create.mock.calls.map((c: unknown[]) => (c[1] as { title?: string }).title);
    expect(titles).toContain('AI Browser Guard - Download not stopped');
    expect(w.cancel).not.toHaveBeenCalled();
  });

  it('matches a start Chrome reports after the download item', async () => {
    const w = await watchedAgentTab(readOnlyWithBlockedSite());
    w.onCreated({ id: 21, url: 'https://b.example.com/late.zip', referrer: 'https://b.example.com/app' });
    await vi.advanceTimersByTimeAsync(50);
    willBegin(55, 'g-21', 'https://b.example.com/late.zip');
    await drain();
    expect(cancelledIds(w)).toEqual([21]);
  });

  it('a report is used once: the same URL created again without a report is not cancelled', async () => {
    const w = await watchedAgentTab(readOnlyWithBlockedSite());
    willBegin(55, 'g-31', 'https://b.example.com/a.zip');
    w.onCreated({ id: 31, url: 'https://b.example.com/a.zip' });
    w.onCreated({ id: 32, url: 'https://b.example.com/a.zip' });
    await drain();
    expect(cancelledIds(w)).toEqual([31]);
  });

  it('the cited recovery works: after closing the agent tab, the same download completes', async () => {
    const w = await watchedAgentTab(readOnlyWithBlockedSite());
    willBegin(55, 'g-41', 'https://b.example.com/export.zip');
    w.onCreated({ id: 41, url: 'https://b.example.com/export.zip' });
    await drain();
    expect(cancelledIds(w)).toEqual([41]);

    onRemoved._fire(55, { windowId: 1, isWindowClosing: false });
    await drain();
    w.onCreated({ id: 42, url: 'https://b.example.com/export.zip' });
    await drain();
    expect(cancelledIds(w)).toEqual([41]);
  });

  it('the cited recovery works: after ending the session delegation, the same download completes', async () => {
    const session = readOnlyWithBlockedSite();
    const w = await watchedAgentTab(session);
    willBegin(55, 'g-61', 'https://b.example.com/export.zip');
    w.onCreated({ id: 61, url: 'https://b.example.com/export.zip' });
    await drain();
    expect(cancelledIds(w)).toEqual([61]);

    send(w.handleMessage, 'DELEGATION_UPDATE', { ...session, isActive: false });
    await drain();
    willBegin(55, 'g-62', 'https://b.example.com/export.zip');
    w.onCreated({ id: 62, url: 'https://b.example.com/export.zip' });
    await drain();
    expect(cancelledIds(w)).toEqual([61]);
    // No rule is left on the tab, so the extension's session there ends too.
    expect(status(w).downloadWatchedAgentIds).toHaveLength(0);
    expect(status(w).lifetimeStats.totalActionsBlocked).toBe(1);
  });

  it("ending the session delegation leaves a grant on the agent's card in force; Revoke on the card then lets the same download complete", async () => {
    const session = readOnlyWithBlockedSite();
    const w = await watchedAgentTab(session);
    const [agentId] = status(w).downloadWatchedAgentIds;
    const card = withBlockedSite(createRuleFromPreset('readOnly', { agentId }));
    send(w.handleMessage, 'DELEGATION_UPDATE', card);
    await drain();
    send(w.handleMessage, 'DELEGATION_UPDATE', { ...session, isActive: false });
    await drain();

    willBegin(55, 'g-71', 'https://b.example.com/export.zip');
    w.onCreated({ id: 71, url: 'https://b.example.com/export.zip' });
    await drain();
    expect(cancelledIds(w)).toEqual([71]);

    send(w.handleMessage, 'DELEGATION_UPDATE', { ...card, isActive: false });
    await drain();
    willBegin(55, 'g-72', 'https://b.example.com/export.zip');
    w.onCreated({ id: 72, url: 'https://b.example.com/export.zip' });
    await drain();
    expect(cancelledIds(w)).toEqual([71]);
  });

  it('a delegation that permits downloads records the reported download without cancelling it', async () => {
    const full = createRuleFromPreset('fullAccess');
    const w = await watchedAgentTab({ ...full, scope: { ...full.scope, sitePatterns: [{ pattern: 'blocked.example', action: 'block' }] } });
    willBegin(55, 'g-51', 'https://b.example.com/export.zip');
    w.onCreated({ id: 51, url: 'https://b.example.com/export.zip' });
    await drain();
    expect(w.cancel).not.toHaveBeenCalled();
    const e = (await downloadEvents()).find((ev) => ev.url === 'https://b.example.com/export.zip');
    expect(e?.attribution?.level).toBe('tab');
    expect(e?.outcome).toBe('informational');
  });

  // Measured on Chrome 145: with DevTools open on the user's own tab, that tab
  // was registered as an agent, our session attached to it, and the user's
  // download there was cancelled as started in the agent's tab.
  it("with DevTools open on the user's tab, a download Chrome reports starting there is recorded as a host match, not cancelled", async () => {
    const w = await watchedAgentTab(readOnlyWithBlockedSite(), [
      { id: 'p1', type: 'page', title: 'Reports', url: 'https://b.example.com/app', attached: true, tabId: 55 },
      DEVTOOLS_FRONT_END,
    ]);
    // The inspected page is listed as an agent, and our session is on its tab.
    expect(status(w).detectedAgents.map((a) => a.confidence)).toEqual(['medium']);
    expect(sendCommand).toHaveBeenCalledWith({ tabId: 55 }, 'Page.enable', {});
    expect(status(w).downloadWatchedAgentIds).toEqual([]);

    willBegin(55, 'g-61', 'https://b.example.com/export.zip');
    w.onCreated({ id: 61, url: 'https://b.example.com/export.zip', referrer: 'https://b.example.com/app', filename: '/d/export.zip' });
    await drain();

    expect(w.cancel).not.toHaveBeenCalled();
    const e = (await downloadEvents()).find((ev) => ev.url === 'https://b.example.com/export.zip');
    expect(e?.outcome).toBe('informational');
    expect(e?.attribution).toEqual({ level: 'host', matchedHost: 'b.example.com' });
    const st = status(w);
    expect(st.lifetimeStats.totalActionsBlocked).toBe(0);
    expect(st.recentViolations).toEqual([]);
  });

  it('a driver registered before DevTools opens in another tab is still cancelled; the inspected tab is not', async () => {
    const w = await watchedAgentTab(readOnlyWithBlockedSite());
    expect(status(w).detectedAgents.map((a) => a.confidence)).toEqual(['high']);

    targets = [
      { id: 'p1', type: 'page', title: 'A', url: 'about:blank', attached: true, tabId: 55 },
      { id: 'p2', type: 'page', title: 'Mine', url: 'https://c.example.org/home', attached: true, tabId: 77 },
      DEVTOOLS_FRONT_END,
    ];
    await vi.advanceTimersByTimeAsync(3_000);
    await drain();
    expect(sendCommand).toHaveBeenCalledWith({ tabId: 77 }, 'Page.enable', {});
    expect(status(w).downloadWatchedAgentIds).toHaveLength(1);

    willBegin(55, 'g-71', 'https://b.example.com/agent.zip');
    w.onCreated({ id: 71, url: 'https://b.example.com/agent.zip' });
    await drain();
    willBegin(77, 'g-72', 'https://c.example.org/mine.pdf');
    w.onCreated({ id: 72, url: 'https://c.example.org/mine.pdf', referrer: 'https://c.example.org/home' });
    await drain();

    expect(cancelledIds(w)).toEqual([71]);
    const events = await downloadEvents();
    expect(events.find((e) => e.url === 'https://c.example.org/mine.pdf')?.attribution)
      .toEqual({ level: 'host', matchedHost: 'c.example.org' });
  });

  describe('two downloads of the same URL, one reported in the agent tab', () => {
    const FILE = 'https://files.example.com/report.pdf';
    let items: Array<{ id: number; url: string; startTime: string }>;

    /** chrome.downloads.search over the items Chrome has created so far, as the real API lists them. */
    function listCreatedItems(): void {
      items = [];
      (chromeMock.downloads as unknown as Record<string, unknown>).search = vi.fn(
        (q: { startedAfter?: string }) => Promise.resolve(
          items.filter((i) => !q.startedAfter || Date.parse(i.startTime) > Date.parse(q.startedAfter)),
        ),
      );
    }

    /** Chrome creates a download item now; its onCreated event is fired separately. */
    function create(id: number) {
      const item = { id, url: FILE, startTime: new Date().toISOString() };
      items.push(item);
      return item;
    }

    afterEach(() => {
      delete (chromeMock.downloads as unknown as Record<string, unknown>).search;
    });

    it("the user's download started first is not cancelled when the agent's tab then reports the same URL", async () => {
      const w = await watchedAgentTab(readOnlyWithBlockedSite());
      listCreatedItems();
      const user = create(81);
      w.onCreated(user);
      await vi.advanceTimersByTimeAsync(1_000);
      const agentItem = create(82);
      willBegin(55, 'g-82', FILE);
      w.onCreated(agentItem);
      await drain();

      expect(cancelledIds(w)).not.toContain(81);
      const events = (await downloadEvents()).filter((e) => e.url === FILE);
      expect(events).toHaveLength(2);
      expect(events.map((e) => e.outcome)).toEqual(['informational', 'informational']);
      expect(status(w).lifetimeStats.totalActionsBlocked).toBe(0);
    });

    it("the user's download created after the report is not cancelled, and the agent's is", async () => {
      const w = await watchedAgentTab(readOnlyWithBlockedSite());
      listCreatedItems();
      const agentItem = create(91);
      willBegin(55, 'g-91', FILE);
      await vi.advanceTimersByTimeAsync(200);
      const user = create(92);
      // The user's onCreated is handled before the agent's.
      w.onCreated(user);
      w.onCreated(agentItem);
      await drain();

      expect(cancelledIds(w)).toEqual([91]);
    });

    // With no other download listed, only the item's own creation time keeps
    // the report from the user's download handled first.
    it.each([
      ['cannot be searched', undefined],
      ['are listed as none', () => Promise.resolve([])],
    ])("when the other downloads %s, the user's download created after the report is not cancelled, and the agent's is", async (_label, search) => {
      const w = await watchedAgentTab(readOnlyWithBlockedSite());
      if (search) (chromeMock.downloads as unknown as Record<string, unknown>).search = vi.fn(search);
      const agentItem = { id: 95, url: FILE, startTime: new Date().toISOString() };
      willBegin(55, 'g-95', FILE);
      await vi.advanceTimersByTimeAsync(200);
      const user = { id: 96, url: FILE, startTime: new Date().toISOString() };
      w.onCreated(user);
      w.onCreated(agentItem);
      await drain();

      expect(cancelledIds(w)).toEqual([95]);
    });

    it('the agent downloading the URL twice has both cancelled once both are reported', async () => {
      const w = await watchedAgentTab(readOnlyWithBlockedSite());
      listCreatedItems();
      const first = create(101);
      willBegin(55, 'g-101', FILE);
      const second = create(102);
      w.onCreated(first);
      await vi.advanceTimersByTimeAsync(20);
      willBegin(55, 'g-102', FILE);
      w.onCreated(second);
      await drain();

      expect(cancelledIds(w).sort()).toEqual([101, 102]);
    });
  });
});
