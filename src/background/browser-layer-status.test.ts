/**
 * The popup is told what Browser-layer blocking is doing in each agent's tab.
 *
 * Before, a refused attach and a session Chrome ended only cleared internal
 * state: enforcement fell back to the page level and nothing said so, and
 * nothing said which tab Chrome's debugging banner was showing for. The status
 * reply now carries, per agent, `attached` while the tab holds the session and
 * `unavailable` (with the cause and what Chrome reported) while the tab
 * warrants a session and holds none.
 *
 * Driven through the real background worker and the repository's chrome mock.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { chromeMock } from '../__tests__/setup';
import { createRuleFromPreset } from '../delegation/rules';
import type { DelegationRule } from '../types/delegation';
import { withBlockedSite } from '../__tests__/download-tab-watch';

const POPUP_SENDER = { id: 'test-id', url: 'chrome-extension://test-id/dist/popup/index.html' };
type Listener = (msg: unknown, sender: unknown, sendResponse: (r: unknown) => void) => boolean;
type AlarmListener = (alarm: { name: string }) => void;
type DetachListener = (source: { tabId?: number }, reason: string) => void;

const TAB = 42;
const AGENT_URL = 'https://shop.example.com/cart';
const REFUSAL = 'Another debugger is already attached to the tab with id: 42.';

const flush = () => new Promise<void>((r) => setTimeout(r, 0));
async function settle(n = 10): Promise<void> {
  for (let i = 0; i < n; i++) await flush();
}

function detection(agentId: string) {
  const methods = ['synthetic-event'];
  return {
    id: `det-${agentId}`, timestamp: new Date().toISOString(), methods, confidence: 'high',
    agent: { id: agentId, type: 'unknown', detectionMethods: methods, confidence: 'high',
      detectedAt: new Date().toISOString(), originUrl: AGENT_URL, observedCapabilities: [], isActive: true },
    url: AGENT_URL, signals: {},
  };
}

/** A chrome.debugger whose attach can be refused and whose sessions Chrome can end. */
function installDebugger() {
  const detachListeners: DetachListener[] = [];
  const attach = vi.fn(() => Promise.resolve());
  const sendCommand = vi.fn((_target: unknown, _method: string) => Promise.resolve({}));
  (chromeMock as unknown as Record<string, unknown>).debugger = {
    attach,
    detach: vi.fn(() => Promise.resolve()),
    sendCommand,
    onEvent: { addListener: vi.fn() },
    onDetach: { addListener: vi.fn((fn: DetachListener) => { detachListeners.push(fn); }) },
    getTargets: (cb: (t: unknown[]) => void) => cb([]),
  };
  return {
    attach,
    sendCommand,
    /** Chrome ends the session on `tabId`, giving `reason`. */
    endSession(tabId: number, reason: string) {
      for (const fn of detachListeners) fn({ tabId }, reason);
    },
  };
}

async function loadWorker() {
  chromeMock.runtime.onMessage.addListener.mockClear();
  chromeMock.alarms.onAlarm.addListener.mockClear();
  await import('./index');
  const last = <T>(calls: unknown[][]) => calls[calls.length - 1][0] as T;
  return {
    handleMessage: last<Listener>(chromeMock.runtime.onMessage.addListener.mock.calls),
    onAlarm: last<AlarmListener>(chromeMock.alarms.onAlarm.addListener.mock.calls),
  };
}
type Worker = Awaited<ReturnType<typeof loadWorker>>;

async function send(w: Worker, type: string, data: unknown, sender: unknown = POPUP_SENDER) {
  const respond = vi.fn();
  w.handleMessage({ type, data }, sender, respond);
  await settle();
  return respond;
}

/**
 * Browser-layer blocking on, an agent in the tab, and a grant to it: `rule`,
 * or by default Read-Only with a blocked site.
 */
async function delegatedAgent(w: Worker, agentId = 'a1', rule?: DelegationRule) {
  await send(w, 'SETTINGS_UPDATE', { cdpEnforcementEnabled: true });
  const origin = new URL(AGENT_URL).origin;
  const r = await send(w, 'DETECTION_RESULT', detection(agentId), { id: 'test-id', tab: { id: TAB }, frameId: 0, url: AGENT_URL, origin });
  expect(r).toHaveBeenCalledWith(expect.objectContaining({ success: true }));
  await send(w, 'DELEGATION_UPDATE', rule ?? withBlockedSite(createRuleFromPreset('readOnly', { agentId })));
}

async function browserLayer(w: Worker): Promise<Record<string, unknown>> {
  const respond = await send(w, 'STATUS_QUERY', {});
  return (respond.mock.calls[0][0] as { browserLayerByAgentId: Record<string, unknown> }).browserLayerByAgentId;
}

beforeEach(async () => {
  vi.resetModules();
  await chromeMock.storage.local.clear();
  (chromeMock as unknown as Record<string, unknown>).debugger = undefined;
});

describe('STATUS_QUERY reports what Browser-layer blocking is doing in each agent tab (#110)', () => {
  it('reports the agent tab as attached while it holds the session', async () => {
    installDebugger();
    const w = await loadWorker();
    await delegatedAgent(w);
    expect(await browserLayer(w)).toEqual({ a1: { state: 'attached' } });
  });

  it('reports a refused attach with what Chrome said, and as attached once a retry succeeds', async () => {
    const dbg = installDebugger();
    dbg.attach.mockImplementation(() => Promise.reject(new Error(REFUSAL)));
    const w = await loadWorker();
    await delegatedAgent(w);
    expect(await browserLayer(w)).toEqual({ a1: { state: 'unavailable', cause: 'attach-failed', detail: REFUSAL } });

    // The periodic alarm retries the attach; the other client has let go.
    dbg.attach.mockImplementation(() => Promise.resolve());
    w.onAlarm({ name: 'cdp-monitor' });
    await settle();
    expect(await browserLayer(w)).toEqual({ a1: { state: 'attached' } });
  });

  it('reports a session Chrome ended, with the reason Chrome gave', async () => {
    const dbg = installDebugger();
    const w = await loadWorker();
    await delegatedAgent(w);
    dbg.endSession(TAB, 'canceled_by_user');
    expect(await browserLayer(w)).toEqual({ a1: { state: 'unavailable', cause: 'detached', detail: 'canceled_by_user' } });
  });

  it('reports nothing once the tab no longer warrants a session', async () => {
    const dbg = installDebugger();
    dbg.attach.mockImplementation(() => Promise.reject(new Error(REFUSAL)));
    const w = await loadWorker();
    await delegatedAgent(w);
    expect(Object.keys(await browserLayer(w))).toEqual(['a1']);
    await send(w, 'SETTINGS_UPDATE', { cdpEnforcementEnabled: false });
    expect(await browserLayer(w)).toEqual({});
  });

  it('reports the agent tab as attached under Read-Only with no blocked site: the session is held to report downloads', async () => {
    const dbg = installDebugger();
    const w = await loadWorker();
    await delegatedAgent(w, 'a1', createRuleFromPreset('readOnly', { agentId: 'a1' }));
    expect(dbg.attach).toHaveBeenCalledWith({ tabId: TAB }, expect.any(String));
    expect(dbg.sendCommand).not.toHaveBeenCalledWith({ tabId: TAB }, 'Fetch.enable', {});
    expect(await browserLayer(w)).toEqual({ a1: { state: 'attached' } });
  });

  it('reports a session held only to report downloads, and dropped because it cannot, as a refused attach', async () => {
    const dbg = installDebugger();
    dbg.sendCommand.mockImplementation((_target: unknown, method: string) =>
      method === 'Page.enable' ? Promise.reject(new Error('Not allowed')) : Promise.resolve({}));
    const w = await loadWorker();
    await delegatedAgent(w, 'a1', createRuleFromPreset('readOnly', { agentId: 'a1' }));
    expect(await browserLayer(w)).toEqual({ a1: { state: 'unavailable', cause: 'attach-failed', detail: 'Not allowed' } });
  });

  it('reports nothing for an agent under a delegation that neither blocks a site nor withholds downloads', async () => {
    const dbg = installDebugger();
    const w = await loadWorker();
    await delegatedAgent(w, 'a1', createRuleFromPreset('fullAccess', { agentId: 'a1' }));
    expect(dbg.attach).not.toHaveBeenCalled();
    expect(await browserLayer(w)).toEqual({});
  });

  it('reports nothing with the setting off', async () => {
    const dbg = installDebugger();
    const w = await loadWorker();
    const origin = new URL(AGENT_URL).origin;
    await send(w, 'DETECTION_RESULT', detection('a1'), { id: 'test-id', tab: { id: TAB }, frameId: 0, url: AGENT_URL, origin });
    await send(w, 'DELEGATION_UPDATE', withBlockedSite(createRuleFromPreset('readOnly', { agentId: 'a1' })));
    expect(dbg.attach).not.toHaveBeenCalled();
    expect(await browserLayer(w)).toEqual({});
  });
});
