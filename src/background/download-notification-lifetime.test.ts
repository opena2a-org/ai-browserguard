/**
 * The "Download blocked" notification is not cleared by the extension (#69).
 *
 * A cancelled download cannot be resumed, and the popup's record of it lives in
 * the worker's memory, so the OS notification is the lasting explanation for a
 * user who was not watching. The download call site passes `autoDismissMs: 0`
 * and leaves the lifetime to the OS. The shared default stays at 10 s, so an
 * "Allow once" alert, whose override has no expiry of its own, still clears on
 * time and never offers a stale action.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { chromeMock } from '../__tests__/setup';
import { createRuleFromPreset } from '../delegation/rules';
import { installDownloadTabWatch, withBlockedSite } from '../__tests__/download-tab-watch';
import { showBoundaryNotification } from '../alerts/notification';
import type { BoundaryAlert } from '../alerts/boundary';

const POPUP_SENDER = { id: 'test-id', url: 'chrome-extension://test-id/dist/popup/index.html' };
const CONTENT_SENDER = {
  id: 'test-id',
  tab: { id: 42 },
  frameId: 0,
  url: 'https://example.test/',
  origin: 'https://example.test',
};

type Listener = (msg: unknown, sender: unknown, sendResponse: (r: unknown) => void) => boolean;

/** Let pending microtasks and zero-delay timers run under fake timers. */
async function settle(rounds = 10): Promise<void> {
  for (let i = 0; i < rounds; i++) await vi.advanceTimersByTimeAsync(0);
}

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

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('download-block notification lifetime', () => {
  it('through the worker path, a download-block notification schedules no clear (0 clears after 1 h)', async () => {
    const downloads = chromeMock.downloads as unknown as Record<string, unknown>;
    downloads.onCreated = { addListener: vi.fn(), removeListener: vi.fn() };
    downloads.cancel = vi.fn((_id: number, cb?: () => void) => { cb?.(); });
    // A download is cancelled only when it starts in the agent's tab on our own
    // debugger session: Browser-layer blocking on, a delegation with a blocked site.
    const watch = installDownloadTabWatch();

    chromeMock.runtime.onMessage.addListener.mockClear();
    await import('./index');
    await settle();
    const calls = chromeMock.runtime.onMessage.addListener.mock.calls;
    const handleMessage = calls[calls.length - 1][0] as Listener;

    handleMessage({ type: 'SETTINGS_UPDATE', data: { cdpEnforcementEnabled: true } }, POPUP_SENDER, vi.fn());
    await settle();
    handleMessage({ type: 'DETECTION_RESULT', data: detectionEvent() }, CONTENT_SENDER, vi.fn());
    await settle();
    handleMessage({ type: 'DELEGATION_UPDATE', data: withBlockedSite(createRuleFromPreset('readOnly')) }, POPUP_SENDER, vi.fn());
    await settle();

    chromeMock.notifications.create.mockClear();
    chromeMock.notifications.clear.mockClear();

    const onCreated = (downloads.onCreated as { addListener: { mock: { calls: unknown[][] } } })
      .addListener.mock.calls[0][0] as (item: unknown) => Promise<void>;
    watch.reportDownloadStart(42, 'https://example.test/exfil.zip');
    await onCreated({
      id: 7,
      url: 'https://example.test/exfil.zip',
      referrer: 'https://example.test/',
      filename: '/tmp/exfil.zip',
    });
    await settle();

    expect(downloads.cancel).toHaveBeenCalledWith(7, expect.any(Function));
    const created = chromeMock.notifications.create.mock.calls.find(
      (c: unknown[]) => (c[1] as { title?: string })?.title?.endsWith('Download blocked'),
    );
    expect(created).toBeDefined();
    const opts = created![1] as { requireInteraction?: boolean; buttons?: unknown[] };
    expect(opts.requireInteraction).toBe(false);
    expect(opts.buttons).toBeUndefined();
    // Ids stay unique per notification (no stable id that would replace the last one).
    expect(String(created![0])).toMatch(/^abg-alert-\d+$/);

    await vi.advanceTimersByTimeAsync(3_600_000);
    expect(chromeMock.notifications.clear).not.toHaveBeenCalled();
  });

  it('an "Allow once" alert is still cleared at exactly 10,000 ms, not at 9,999', () => {
    chromeMock.notifications.create.mockClear();
    chromeMock.notifications.clear.mockClear();
    const alert = {
      violation: {
        id: 'v1',
        timestamp: new Date().toISOString(),
        agentId: 'agent-1',
        attemptedAction: 'click',
        url: 'https://example.test/',
        blockingRuleId: 'r1',
        reason: 'test',
        userOverride: false,
      },
      severity: 'high',
      title: 'Action blocked',
      message: 'test',
      allowOneTimeOverride: true,
      acknowledged: false,
    } as unknown as BoundaryAlert;

    const id = showBoundaryNotification(alert, { enabled: true });
    const opts = chromeMock.notifications.create.mock.calls[0][1] as { buttons?: Array<{ title: string }> };
    expect(opts.buttons?.map((b) => b.title)).toEqual(['Allow once', 'Dismiss']);

    vi.advanceTimersByTime(9_999);
    expect(chromeMock.notifications.clear).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(chromeMock.notifications.clear).toHaveBeenCalledTimes(1);
    expect(chromeMock.notifications.clear).toHaveBeenCalledWith(id);
  });
});
