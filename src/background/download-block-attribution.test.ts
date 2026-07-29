/**
 * Regression: a cancelled agent download gets the full attribution chain (F-A).
 *
 * Pre-fix, blocking an agent download was badge-only: the download vanished
 * from the user's shelf with no notification, no recent-violations entry, and
 * no explanation anywhere — the canonical "blocked download, no idea why".
 * Post-fix it carries the same chain as every other block: an in-the-moment
 * notification (honoring the Notifications setting) and a findable entry in
 * the popup's recent list, with a plain-language why. Both assertions fail on
 * the pre-fix code.
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
});

describe('F-A: blocked agent download is attributed, not silent', () => {
  it('shows a notification and records a recent-violations entry when a download is cancelled', async () => {
    // The shipped mock has no downloads.onCreated/cancel; install them BEFORE
    // the worker imports so the monitor actually registers (the background
    // swallows a failed registration).
    const downloads = chromeMock.downloads as unknown as Record<string, unknown>;
    downloads.onCreated = { addListener: vi.fn(), removeListener: vi.fn() };
    downloads.cancel = vi.fn((_id: number, cb?: () => void) => { cb?.(); });

    chromeMock.runtime.onMessage.addListener.mockClear();
    chromeMock.notifications.create.mockClear();
    await import('./index');
    const calls = chromeMock.runtime.onMessage.addListener.mock.calls;
    const handleMessage = calls[calls.length - 1][0] as Listener;

    // An agent is active on tab 42...
    const detResp = vi.fn();
    handleMessage({ type: 'DETECTION_RESULT', data: detectionEvent() }, CONTENT_SENDER, detResp);
    await flush();
    await flush();
    expect(detResp).toHaveBeenCalledWith(expect.objectContaining({ success: true }));

    // ...under a Read-Only delegation (download-file not permitted).
    const rule = createRuleFromPreset('readOnly');
    const delResp = vi.fn();
    handleMessage({ type: 'DELEGATION_UPDATE', data: rule }, POPUP_SENDER, delResp);
    await flush();
    await flush();
    expect(delResp).toHaveBeenCalledWith(expect.objectContaining({ success: true }));

    // The agent's page triggers a download.
    const onCreated = (downloads.onCreated as { addListener: { mock: { calls: unknown[][] } } })
      .addListener.mock.calls[0][0] as (item: unknown) => Promise<void>;
    await onCreated({
      id: 7,
      url: 'https://example.test/exfil.zip',
      referrer: 'https://example.test/',
      filename: '/tmp/exfil.zip',
    });
    for (let i = 0; i < 6; i++) await flush();

    // The download was cancelled...
    expect(downloads.cancel).toHaveBeenCalledWith(7, expect.any(Function));

    // ...and the user can tell: an in-the-moment notification with a
    // plain-language why (pre-fix: notifications.create never called here)...
    expect(chromeMock.notifications.create).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        title: expect.stringContaining('Download blocked'),
        message: expect.stringContaining('Cancelled an agent download'),
      }),
    );
    // ...with no "Allow once" button — the download cannot be resumed, and an
    // inert button is its own bug class.
    const createOpts = chromeMock.notifications.create.mock.calls.find(
      (c: unknown[]) => (c[1] as { title?: string })?.title?.includes('Download blocked'),
    )?.[1] as { buttons?: unknown[] } | undefined;
    expect(createOpts?.buttons).toBeUndefined();

    // ...and a findable record in the popup's recent list (pre-fix: absent).
    const statusResp = vi.fn();
    handleMessage({ type: 'STATUS_QUERY', data: {} }, POPUP_SENDER, statusResp);
    await flush();
    const status = statusResp.mock.calls[0][0] as {
      recentViolations: Array<{ violation: { attemptedAction: string; url: string } }>;
    };
    expect(status.recentViolations.some(
      (a) => a.violation?.attemptedAction === 'download-file'
        && a.violation?.url === 'https://example.test/exfil.zip',
    )).toBe(true);

    void storageData; // storage side effects covered by download-monitor tests
  });

  it('a burst of blocked downloads coalesces to one notification but records every block', async () => {
    const downloads = chromeMock.downloads as unknown as Record<string, unknown>;
    downloads.onCreated = { addListener: vi.fn(), removeListener: vi.fn() };
    downloads.cancel = vi.fn((_id: number, cb?: () => void) => { cb?.(); });

    chromeMock.runtime.onMessage.addListener.mockClear();
    chromeMock.notifications.create.mockClear();
    await import('./index');
    const calls = chromeMock.runtime.onMessage.addListener.mock.calls;
    const handleMessage = calls[calls.length - 1][0] as Listener;

    const detResp = vi.fn();
    handleMessage({ type: 'DETECTION_RESULT', data: detectionEvent() }, CONTENT_SENDER, detResp);
    await flush();
    await flush();
    const rule = createRuleFromPreset('readOnly');
    const delResp = vi.fn();
    handleMessage({ type: 'DELEGATION_UPDATE', data: rule }, POPUP_SENDER, delResp);
    await flush();
    await flush();

    const onCreated = (downloads.onCreated as { addListener: { mock: { calls: unknown[][] } } })
      .addListener.mock.calls[0][0] as (item: unknown) => Promise<void>;
    for (const id of [11, 12, 13]) {
      await onCreated({
        id,
        url: `https://example.test/burst-${id}.zip`,
        referrer: 'https://example.test/',
        filename: `/tmp/burst-${id}.zip`,
      });
    }
    for (let i = 0; i < 6; i++) await flush();

    // One OS notification for the burst (coalesced)...
    const blockedNotifications = chromeMock.notifications.create.mock.calls.filter(
      (c: unknown[]) => (c[1] as { title?: string })?.title?.includes('Download blocked'),
    );
    expect(blockedNotifications).toHaveLength(1);

    // ...but every block is findable in the recent list.
    const statusResp = vi.fn();
    handleMessage({ type: 'STATUS_QUERY', data: {} }, POPUP_SENDER, statusResp);
    await flush();
    const status = statusResp.mock.calls[0][0] as {
      recentViolations: Array<{ violation: { attemptedAction: string } }>;
    };
    expect(status.recentViolations.filter(
      (a) => a.violation?.attemptedAction === 'download-file',
    )).toHaveLength(3);
  });

  it('an allowed download stays un-notified (no noise on the informational path)', async () => {
    const downloads = chromeMock.downloads as unknown as Record<string, unknown>;
    downloads.onCreated = { addListener: vi.fn(), removeListener: vi.fn() };
    downloads.cancel = vi.fn((_id: number, cb?: () => void) => { cb?.(); });

    chromeMock.runtime.onMessage.addListener.mockClear();
    chromeMock.notifications.create.mockClear();
    await import('./index');
    const calls = chromeMock.runtime.onMessage.addListener.mock.calls;
    const handleMessage = calls[calls.length - 1][0] as Listener;

    const detResp = vi.fn();
    handleMessage({ type: 'DETECTION_RESULT', data: detectionEvent() }, CONTENT_SENDER, detResp);
    await flush();
    await flush();

    // fullAccess permits download-file: observed, never blocked, no alert.
    const rule = createRuleFromPreset('fullAccess');
    const delResp = vi.fn();
    handleMessage({ type: 'DELEGATION_UPDATE', data: rule }, POPUP_SENDER, delResp);
    await flush();
    await flush();

    const onCreated = (downloads.onCreated as { addListener: { mock: { calls: unknown[][] } } })
      .addListener.mock.calls[0][0] as (item: unknown) => Promise<void>;
    await onCreated({
      id: 8,
      url: 'https://example.test/ok.pdf',
      referrer: 'https://example.test/',
      filename: '/tmp/ok.pdf',
    });
    for (let i = 0; i < 6; i++) await flush();

    expect(downloads.cancel).not.toHaveBeenCalled();
    const blockedNotification = chromeMock.notifications.create.mock.calls.find(
      (c: unknown[]) => (c[1] as { title?: string })?.title?.includes('Download blocked'),
    );
    expect(blockedNotification).toBeUndefined();
  });
});
