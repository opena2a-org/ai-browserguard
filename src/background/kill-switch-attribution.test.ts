/**
 * Regression tests for kill-switch attribution and mutation ordering
 * (field-test F-M / F-D and the 0.6.1 review follow-ups).
 *
 * F-M: the kill switch closes the tabs an agent controls; each closure fires
 * tabs.onRemoved, whose handler ends that tab's session as 'page-unload'. On
 * the pre-fix code that handler won the race against the kill-switch teardown,
 * which then skipped the "already ended" session — so no session was EVER
 * recorded as ended by 'kill-switch', and the most disruptive action the
 * extension takes was unattributed on every surface a user checks.
 *
 * F-D: STATUS_QUERY did not carry the kill-switch event, so the popup could
 * not say what the stop actually did (how many tabs it closed).
 *
 * Ordering: ACTIVATE and RESET ran unserialized; an ACTIVATE still executing
 * while a RESET completed would re-latch state the user just cleared.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { chromeMock, storageData } from '../__tests__/setup';

const POPUP_SENDER = { id: 'test-id', url: 'chrome-extension://test-id/dist/popup/index.html' };
const CONTENT_SENDER = {
  id: 'test-id',
  tab: { id: 42 },
  frameId: 0,
  url: 'https://example.test/',
  origin: 'chrome-extension://test-id',
};

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

type Listener = (msg: unknown, sender: unknown, sendResponse: (r: unknown) => void) => boolean;

function detectionEvent() {
  return {
    id: 'det-1',
    timestamp: new Date().toISOString(),
    methods: ['cdp-connection'],
    confidence: 'high',
    agent: {
      id: 'agent-1',
      type: 'playwright',
      detectionMethods: ['cdp-connection'],
      confidence: 'high',
      detectedAt: new Date().toISOString(),
      originUrl: 'https://example.test/',
      observedCapabilities: [],
      isActive: true,
    },
    url: 'https://example.test/',
    signals: {},
  };
}

async function importWorker(): Promise<Listener> {
  chromeMock.runtime.onMessage.addListener.mockClear();
  await import('./index');
  const calls = chromeMock.runtime.onMessage.addListener.mock.calls;
  return calls[calls.length - 1][0] as Listener;
}

async function registerAgent(handleMessage: Listener): Promise<void> {
  const resp = vi.fn();
  handleMessage({ type: 'DETECTION_RESULT', data: detectionEvent() }, CONTENT_SENDER, resp);
  await flush();
  await flush();
  expect(resp).toHaveBeenCalledWith(expect.objectContaining({ success: true }));
}

beforeEach(() => {
  vi.resetModules();
});

describe('F-M: sessions ended by the kill switch say so', () => {
  it("records endReason 'kill-switch' (not 'page-unload') when the stop closes the agent's tab, and reports the session exactly once", async () => {
    const handleMessage = await importWorker();
    await registerAgent(handleMessage);

    // Reproduce the field-observed interleaving: closing a tab fires
    // tabs.onRemoved before the kill-switch teardown reads storage. The mock
    // dispatches the removal handler as part of tabs.remove, exactly the
    // ordering Chrome produced live.
    const onRemovedListeners = chromeMock.tabs.onRemoved.addListener.mock.calls
      .map((c: unknown[]) => c[0] as (tabId: number) => void);
    (chromeMock.tabs as unknown as { remove: unknown }).remove = vi.fn(async (tabId: number) => {
      for (const l of onRemovedListeners) l(tabId);
      await flush();
    });

    const resp = vi.fn();
    handleMessage({ type: 'KILL_SWITCH_ACTIVATE', data: { trigger: 'button' } }, POPUP_SENDER, resp);
    for (let i = 0; i < 8; i++) await flush();

    expect(resp).toHaveBeenCalledWith(expect.objectContaining({ success: true }));
    const sessions = storageData.sessions as Array<{ endReason: string | null; endedAt: string | null }>;
    expect(sessions).toHaveLength(1);
    expect(sessions[0].endedAt).not.toBeNull();
    // Pre-fix: 'page-unload' — the tab-close handler won and the kill-switch
    // teardown skipped the already-ended session.
    expect(sessions[0].endReason).toBe('kill-switch');

    // Exactly one report — the tab-close handler must not report an
    // already-ended session a second time.
    const reports = (storageData.reports as unknown[] | undefined) ?? [];
    expect(reports).toHaveLength(1);
  });
});

describe('F-D: STATUS_QUERY carries what the stop did', () => {
  it('exposes killSwitchLastEvent with the closed tab ids', async () => {
    const handleMessage = await importWorker();
    await registerAgent(handleMessage);

    const onRemovedListeners = chromeMock.tabs.onRemoved.addListener.mock.calls
      .map((c: unknown[]) => c[0] as (tabId: number) => void);
    (chromeMock.tabs as unknown as { remove: unknown }).remove = vi.fn(async (tabId: number) => {
      for (const l of onRemovedListeners) l(tabId);
    });

    const activateResp = vi.fn();
    handleMessage({ type: 'KILL_SWITCH_ACTIVATE', data: { trigger: 'button' } }, POPUP_SENDER, activateResp);
    for (let i = 0; i < 8; i++) await flush();

    const statusResp = vi.fn();
    handleMessage({ type: 'STATUS_QUERY', data: {} }, POPUP_SENDER, statusResp);
    await flush();

    expect(statusResp).toHaveBeenCalledWith(expect.objectContaining({
      killSwitchActive: true,
      killSwitchLastEvent: expect.objectContaining({
        closedTabIds: [42],
        trigger: 'button',
      }),
    }));
  });
});

describe('kill-switch mutations are serialized', () => {
  it('a RESET issued while an ACTIVATE is mid-flight runs after it — the latch ends CLEAR, in memory and on disk', async () => {
    const handleMessage = await importWorker();
    await registerAgent(handleMessage);

    // Hold the ACTIVATE open mid-execution (inside tab teardown) while the
    // RESET arrives. Pre-fix, the unserialized RESET completed during this
    // window and the resuming ACTIVATE re-latched the switch the user had
    // just cleared; the queue makes the RESET wait and win.
    let releaseRemove!: () => void;
    const removeGate = new Promise<void>((r) => { releaseRemove = r; });
    (chromeMock.tabs as unknown as { remove: unknown }).remove = vi.fn(() => removeGate);

    const activateResp = vi.fn();
    handleMessage({ type: 'KILL_SWITCH_ACTIVATE', data: { trigger: 'button' } }, POPUP_SENDER, activateResp);
    await flush();

    const resetResp = vi.fn();
    handleMessage({ type: 'KILL_SWITCH_RESET', data: {} }, POPUP_SENDER, resetResp);
    await flush();

    releaseRemove();
    for (let i = 0; i < 10; i++) await flush();

    expect(activateResp).toHaveBeenCalledWith(expect.objectContaining({ success: true }));
    expect(resetResp).toHaveBeenCalledWith(expect.objectContaining({ success: true }));

    const statusResp = vi.fn();
    handleMessage({ type: 'STATUS_QUERY', data: {} }, POPUP_SENDER, statusResp);
    await flush();
    expect(statusResp).toHaveBeenCalledWith(
      expect.objectContaining({ killSwitchActive: false }),
    );
    expect((storageData.killSwitchState as { isActive: boolean }).isActive).toBe(false);
  });
});

describe('ACTIVATE does not depend on a successful state load', () => {
  it('stops agents and persists the latch even while the load keeps failing', async () => {
    const handleMessage = await importWorker();
    await registerAgent(handleMessage);

    // From here on, every read of the kill-switch key fails — the load path
    // (ensureReady) rejects on each attempt. The emergency stop must still
    // run: it acts on in-memory agents and persists its own latch.
    const original = chromeMock.storage.local.get.getMockImplementation()!;
    chromeMock.storage.local.get.mockImplementation((keys, cb) => {
      if (keys === 'killSwitchState') return Promise.reject(new Error('storage read failed'));
      return original(keys, cb);
    });

    const onRemovedListeners = chromeMock.tabs.onRemoved.addListener.mock.calls
      .map((c: unknown[]) => c[0] as (tabId: number) => void);
    (chromeMock.tabs as unknown as { remove: unknown }).remove = vi.fn(async (tabId: number) => {
      for (const l of onRemovedListeners) l(tabId);
    });

    const resp = vi.fn();
    handleMessage({ type: 'KILL_SWITCH_ACTIVATE', data: { trigger: 'button' } }, POPUP_SENDER, resp);
    for (let i = 0; i < 10; i++) await flush();

    // Pre-hardening: the rejected load aborted the queued op, the response was
    // { success: false }, and the stop never ran while the popup could still
    // render "Killed".
    expect(resp).toHaveBeenCalledWith(expect.objectContaining({
      success: true,
      event: expect.objectContaining({ closedTabIds: [42] }),
    }));
    expect((storageData.killSwitchState as { isActive: boolean }).isActive).toBe(true);

    chromeMock.storage.local.get.mockImplementation(original);
  });
});

describe('a hung tab close cannot wedge the kill switch', () => {
  it('ACTIVATE completes despite a never-resolving tabs.remove, and a queued RESET still runs', async () => {
    const handleMessage = await importWorker();
    await registerAgent(handleMessage);

    // chrome.tabs.remove hangs forever (a page's beforeunload prompt). The
    // bounded close must let the stop finish; pre-hardening the whole
    // mutation queue wedged behind it, including the user's RESET.
    (chromeMock.tabs as unknown as { remove: unknown }).remove =
      vi.fn(() => new Promise(() => { /* never resolves */ }));

    const activateResp = vi.fn();
    handleMessage({ type: 'KILL_SWITCH_ACTIVATE', data: { trigger: 'button' } }, POPUP_SENDER, activateResp);
    const resetResp = vi.fn();
    handleMessage({ type: 'KILL_SWITCH_RESET', data: {} }, POPUP_SENDER, resetResp);

    // Wait past the per-tab close bound (1500ms) plus queue turnover.
    await new Promise((r) => setTimeout(r, 2200));
    for (let i = 0; i < 10; i++) await flush();

    expect(activateResp).toHaveBeenCalledWith(expect.objectContaining({
      success: true,
      // The hung tab is NOT counted as a confirmed close.
      event: expect.objectContaining({ closedTabIds: [] }),
    }));
    expect(resetResp).toHaveBeenCalledWith(expect.objectContaining({ success: true }));
    expect((storageData.killSwitchState as { isActive: boolean }).isActive).toBe(false);
  }, 10000);
});

describe('kill-switch storage reads fail loud, not open', () => {
  it('getKillSwitchState rejects on a storage read error instead of silently lifting the latch', async () => {
    const { getKillSwitchState } = await import('../session/storage');
    const original = chromeMock.storage.local.get.getMockImplementation()!;
    chromeMock.storage.local.get.mockImplementationOnce(() =>
      Promise.reject(new Error('storage read failed')),
    );
    // Pre-fix: resolved to the inactive default — a latched emergency stop
    // silently lifted on a storage blip.
    await expect(getKillSwitchState()).rejects.toThrow('storage read failed');
    chromeMock.storage.local.get.mockImplementation(original);
  });
});
