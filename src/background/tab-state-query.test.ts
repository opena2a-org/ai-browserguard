/**
 * Regression: content scripts can pull their tab's state at startup
 * (TAB_STATE_QUERY), and the pull survives sender validation.
 *
 * The startup pull used STATUS_QUERY, which sender validation classifies
 * popup-only — content scripts always carry sender.tab, so the pull was
 * silently rejected on every page load. Two consequences, both invisible to
 * the unit suites and found by the 0.6.2 arming smoke: a tab opened (or
 * navigated) after a delegation activated never received its rule, and a
 * navigation during an active kill switch did not re-arm the MAIN-world
 * sentinel — the exact bypass the pull's own comment says it prevents.
 * These tests fail on the pre-fix code (the message type did not exist).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { chromeMock, storageData } from '../__tests__/setup';
import { createRuleFromPreset } from '../delegation/rules';

const POPUP_SENDER = { id: 'test-id', url: 'chrome-extension://test-id/dist/popup/index.html' };
const CONTENT_SENDER = {
  id: 'test-id',
  tab: { id: 42 },
  frameId: 0,
  url: 'https://example.test/',
  // Real content-script senders carry the PAGE's origin, never the
  // extension's — a validator requiring the extension origin here is the
  // production bug this shape exists to catch.
  origin: 'https://example.test',
};

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

type Listener = (msg: unknown, sender: unknown, sendResponse: (r: unknown) => void) => boolean;

async function importWorker(): Promise<Listener> {
  chromeMock.runtime.onMessage.addListener.mockClear();
  await import('./index');
  for (let i = 0; i < 4; i++) await flush();
  const calls = chromeMock.runtime.onMessage.addListener.mock.calls;
  return calls[calls.length - 1][0] as Listener;
}

beforeEach(() => {
  vi.resetModules();
});

describe('TAB_STATE_QUERY (content-script startup pull)', () => {
  it('a tab opened after a delegation activates receives the effective rule', async () => {
    const handleMessage = await importWorker();

    // The user activates a session-wide Read-Only rule from the popup wizard.
    const rule = createRuleFromPreset('readOnly');
    const delResp = vi.fn();
    handleMessage({ type: 'DELEGATION_UPDATE', data: rule }, POPUP_SENDER, delResp);
    for (let i = 0; i < 4; i++) await flush();
    expect(delResp).toHaveBeenCalledWith(expect.objectContaining({ success: true }));

    // A NEW tab's content script pulls at startup. Pre-fix (STATUS_QUERY,
    // popup-only) this was rejected and the tab never armed.
    const pullResp = vi.fn();
    const handled = handleMessage({ type: 'TAB_STATE_QUERY', data: {} }, CONTENT_SENDER, pullResp);
    expect(handled).toBe(true); // async response promised
    for (let i = 0; i < 4; i++) await flush();
    expect(pullResp).toHaveBeenCalledWith(expect.objectContaining({
      effectiveRule: expect.objectContaining({ preset: 'readOnly', isActive: true }),
      killSwitchActive: false,
    }));
  });

  it('a navigation during an active kill switch re-arms from the persisted latch (fresh worker)', async () => {
    // Latched kill switch on disk; the worker has just restarted (its
    // in-memory default is inactive until the load completes). The pull must
    // answer from LOADED state, or every navigation would lift the emergency.
    await chromeMock.storage.local.set({
      killSwitchState: {
        isActive: true,
        lastEvent: null,
        lastActivatedAt: new Date().toISOString(),
      },
    });
    const handleMessage = await importWorker();

    const pullResp = vi.fn();
    handleMessage({ type: 'TAB_STATE_QUERY', data: {} }, CONTENT_SENDER, pullResp);
    for (let i = 0; i < 4; i++) await flush();
    expect(pullResp).toHaveBeenCalledWith(expect.objectContaining({
      killSwitchActive: true,
    }));

    void storageData;
  });

  it('answers with best-effort state when the load keeps failing — a tab must never be left with silence', async () => {
    const original = chromeMock.storage.local.get.getMockImplementation()!;
    chromeMock.storage.local.get.mockImplementation((keys, cb) => {
      if (keys === 'killSwitchState') return Promise.reject(new Error('storage read failed'));
      return original(keys, cb);
    });
    const handleMessage = await importWorker();

    const pullResp = vi.fn();
    handleMessage({ type: 'TAB_STATE_QUERY', data: {} }, CONTENT_SENDER, pullResp);
    for (let i = 0; i < 4; i++) await flush();
    // An unanswered pull would leave the tab with NO rule and NO sentinel —
    // strictly worse than the in-memory view.
    expect(pullResp).toHaveBeenCalledWith(expect.objectContaining({
      killSwitchActive: expect.any(Boolean),
    }));

    chromeMock.storage.local.get.mockImplementation(original);
  });

  it('STATUS_QUERY stays popup-only — the full status payload is not exposed to content scripts', async () => {
    const handleMessage = await importWorker();
    const resp = vi.fn();
    const handled = handleMessage({ type: 'STATUS_QUERY', data: {} }, CONTENT_SENDER, resp);
    expect(handled).toBe(false);
    await flush();
    expect(resp).not.toHaveBeenCalled();
  });
});
