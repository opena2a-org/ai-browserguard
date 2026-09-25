/**
 * The staged-update policy wired into the real background worker (issue #68):
 * the onUpdateAvailable listener, the delegation-check re-check, STATUS_QUERY's
 * pendingUpdate, and the popup-only UPDATE_APPLY message.
 *
 * Each test imports a fresh worker. Event mocks keep every earlier import's
 * listeners, so each test drives only the listener its own import registered.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { chromeMock } from '../__tests__/setup';
import { createRuleFromPreset } from '../delegation/rules';

const POPUP_SENDER = { id: 'test-id', url: 'chrome-extension://test-id/dist/popup/index.html' };
const CONTENT_SENDER = { id: 'test-id', tab: { id: 42 }, frameId: 0, url: 'https://example.com/', origin: 'https://example.com' };

type Listener = (msg: unknown, sender: unknown, sendResponse: (r: unknown) => void) => boolean;
type UpdateListener = (details: { version: string }) => void;
type AlarmListener = (alarm: { name: string }) => void;

const flush = () => new Promise<void>((r) => setTimeout(r, 0));
async function settle(n = 6): Promise<void> {
  for (let i = 0; i < n; i++) await flush();
}

const runtime = chromeMock.runtime as unknown as {
  onUpdateAvailable: { addListener: { mock: { calls: unknown[][] }; mockClear: () => void } };
  reload: ReturnType<typeof vi.fn>;
};

async function loadWorker() {
  chromeMock.runtime.onMessage.addListener.mockClear();
  runtime.onUpdateAvailable.addListener.mockClear();
  chromeMock.alarms.onAlarm.addListener.mockClear();
  await import('./index');
  const last = <T>(calls: unknown[][]) => calls[calls.length - 1][0] as T;
  return {
    handleMessage: last<Listener>(chromeMock.runtime.onMessage.addListener.mock.calls),
    onUpdate: last<UpdateListener>(runtime.onUpdateAvailable.addListener.mock.calls),
    onAlarm: last<AlarmListener>(chromeMock.alarms.onAlarm.addListener.mock.calls),
  };
}

function send(handleMessage: Listener, type: string, data: unknown, sender: unknown = POPUP_SENDER) {
  const respond = vi.fn();
  const accepted = handleMessage({ type, data }, sender, respond);
  return { respond, accepted };
}

beforeEach(async () => {
  vi.resetModules();
  await chromeMock.storage.local.clear();
  runtime.reload.mockClear();
});

describe('staged update in the background worker', () => {
  it('registers an onUpdateAvailable listener and reloads at once when idle', async () => {
    const w = await loadWorker();
    await settle();
    w.onUpdate({ version: '0.7.1' });
    await settle();
    expect(runtime.reload).toHaveBeenCalledTimes(1);
  });

  it('holds the update while a delegation is active, reports it, and applies it on the delegation-check tick after the delegation ends', async () => {
    const w = await loadWorker();
    const rule = createRuleFromPreset('readOnly');
    send(w.handleMessage, 'DELEGATION_UPDATE', rule);
    await settle();

    w.onUpdate({ version: '0.7.1' });
    await settle();
    w.onAlarm({ name: 'delegation-check' });
    await settle();
    expect(runtime.reload).not.toHaveBeenCalled();

    const status = send(w.handleMessage, 'STATUS_QUERY', {});
    expect(status.respond.mock.calls[0][0]).toMatchObject({ pendingUpdate: { version: '0.7.1' } });

    send(w.handleMessage, 'DELEGATION_UPDATE', { ...rule, isActive: false });
    await settle();
    expect(runtime.reload).not.toHaveBeenCalled();
    w.onAlarm({ name: 'delegation-check' });
    await settle();
    expect(runtime.reload).toHaveBeenCalledTimes(1);
  });

  it('never reloads while the kill switch is engaged, on arrival or on the tick', async () => {
    const w = await loadWorker();
    send(w.handleMessage, 'KILL_SWITCH_ACTIVATE', { trigger: 'button-click' });
    await settle(12);
    w.onUpdate({ version: '0.7.1' });
    await settle();
    w.onAlarm({ name: 'delegation-check' });
    await settle();
    expect(runtime.reload).not.toHaveBeenCalled();
  });

  it('does not reload through a delegation that is active on disk while the state load is still in flight', async () => {
    const rule = createRuleFromPreset('readOnly');
    await chromeMock.storage.local.set({ delegationRules: [rule] });
    const originalGet = chromeMock.storage.local.get.getMockImplementation()!;
    let releaseLoad!: () => void;
    const loadGate = new Promise<void>((r) => { releaseLoad = r; });
    chromeMock.storage.local.get.mockImplementation((keys, cb) => {
      const snapshot = originalGet(keys, cb) as Promise<Record<string, unknown>>;
      return loadGate.then(() => snapshot);
    });
    try {
      const w = await loadWorker();
      w.onUpdate({ version: '0.7.1' });
      await settle();
      expect(runtime.reload).not.toHaveBeenCalled();
      releaseLoad();
      await settle();
      expect(runtime.reload).not.toHaveBeenCalled();
    } finally {
      chromeMock.storage.local.get.mockImplementation(originalGet);
    }
  });

  it('UPDATE_APPLY from the popup applies a pending update; from a page it is refused', async () => {
    const w = await loadWorker();
    send(w.handleMessage, 'DELEGATION_UPDATE', createRuleFromPreset('readOnly'));
    await settle();
    w.onUpdate({ version: '0.7.1' });
    await settle();

    const fromPage = send(w.handleMessage, 'UPDATE_APPLY', {}, CONTENT_SENDER);
    await settle();
    expect(runtime.reload).not.toHaveBeenCalled();
    expect(fromPage.respond).not.toHaveBeenCalledWith(expect.objectContaining({ success: true }));

    const fromPopup = send(w.handleMessage, 'UPDATE_APPLY', {});
    await settle();
    expect(fromPopup.respond).toHaveBeenCalledWith({ success: true });
    expect(runtime.reload).toHaveBeenCalledTimes(1);
  });

  it('UPDATE_APPLY with nothing pending does not reload', async () => {
    const w = await loadWorker();
    await settle();
    const r = send(w.handleMessage, 'UPDATE_APPLY', {});
    await settle();
    expect(r.respond).toHaveBeenCalledWith({ success: false });
    expect(runtime.reload).not.toHaveBeenCalled();
  });
});
