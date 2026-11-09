/**
 * Fresh-install zero-network assertion.
 *
 * The Chrome Web Store listing and privacy policy claim the extension makes
 * zero network requests *by default*. This test locks that claim in: with the
 * shipped default settings, neither opt-in network path (registry lookup,
 * ai-safety.txt declaration) may fire. The gating is what makes the "off by
 * default, optional opt-in" disclosure (ADR-006) true, so a regression here is
 * a disclosure bug.
 *
 * The ai-safety.txt gate (ADR-009) carries more weight than the other one: it
 * is the only path that contacts a site we do not control. A regression that
 * defaulted it ON would not just break the zero-network claim, it would start
 * revealing to third-party origins that this user runs an agent — the disclosure
 * ADR-009 exists to bound.
 *
 * The extension sends no contribution event. A profile an earlier version left
 * with contribution turned on still holds that consent record, so the last
 * block seeds it and drives detections and a session end through the
 * background worker.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { DEFAULT_SETTINGS } from '../session/types';
import { lookupAiSafetyDeclaration } from '../aisafety/client';
import { clearAiSafetyCache } from '../aisafety/cache';
import { chromeMock, storageData } from './setup';

// Spy on global fetch. Any call to it during a fresh-install flow fails the
// test.
const mockFetch = vi.fn((): Promise<unknown> => {
  throw new Error('fetch must not be called on a fresh install before opt-in');
});
(globalThis as Record<string, unknown>).fetch = mockFetch;
(chrome.runtime as Record<string, unknown>).getManifest = vi.fn(() => ({ version: '0.4.2' }));

beforeEach(() => {
  mockFetch.mockClear();
});

describe('fresh install makes zero network requests', () => {
  it('ships the trust-lookup gate default OFF', () => {
    expect(DEFAULT_SETTINGS.registryLookupEnabled).toBe(false);
  });

  it('ships the ai-safety.txt gate default OFF', () => {
    // The only setting that lets the extension contact a third-party origin.
    expect(DEFAULT_SETTINGS.aiSafetyTxtEnabled).toBe(false);
  });

  it('does not read a site declaration on a fresh profile', async () => {
    // Stronger than asserting the default value: this calls the real entry
    // point, on fresh storage, and proves no request reaches the site. The
    // registry lookup's gate lives in the background service worker, where
    // background/trust-lookup-registry-only.test.ts holds it. This path
    // contacts a site we do not control, so its gate is placed where a test
    // can actually hold it.
    await clearAiSafetyCache();
    const result = await lookupAiSafetyDeclaration('https://example.com/page');

    expect(result).toEqual({ status: 'unreachable' });
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Contribution: no request and no queued event, whatever consent is stored.
// ---------------------------------------------------------------------------

/** The consent record an earlier version stored once contribution was turned on. */
const STORED_OPT_IN = {
  enabled: true,
  grantedAt: '2026-01-01T00:00:00.000Z',
  tipShown: true,
  tipDismissed: false,
  detectionsSinceInstall: 0,
  firstDetectionAt: null,
};

/** Earlier versions sent their queue to the registry once it held this many events. */
const EARLIER_BATCH_SIZE = 10;

const CONTENT_SENDER = {
  id: 'test-id',
  frameId: 0,
  url: 'https://example.test/',
  origin: 'https://example.test',
};

type MessageListener = (msg: unknown, sender: unknown, sendResponse: (r: unknown) => void) => boolean;

function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

async function settleAll(): Promise<void> {
  for (let i = 0; i < 10; i++) await settle();
}

function detectionEvent(tabId: number) {
  const agentId = `agent-${tabId}`;
  return {
    id: `det-${agentId}`,
    timestamp: new Date().toISOString(),
    methods: ['cdp-connection'],
    confidence: 'high',
    agent: {
      id: agentId,
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

// Answers every request with a reply that stores the whole batch, so a batch
// sent at the batch size would leave the queue empty and the count below
// would show exactly when it was sent.
const requestedUrls: string[] = [];
const recordingFetch = vi.fn((input: unknown): Promise<unknown> => {
  requestedUrls.push(String(input));
  return Promise.resolve({
    ok: true,
    status: 200,
    json: () => Promise.resolve({ accepted: EARLIER_BATCH_SIZE }),
  });
});

/** Requests the fetch double saw whose URL path is the registry's contribute route. */
function contributeRequests(): number {
  return requestedUrls.filter((url) => new URL(url).pathname === '/api/v1/contribute').length;
}

async function startWorker(): Promise<MessageListener> {
  vi.resetModules();
  chromeMock.runtime.onMessage.addListener.mockClear();
  await import('../background/index');
  await settleAll();
  const calls = chromeMock.runtime.onMessage.addListener.mock.calls;
  return calls[calls.length - 1][0] as MessageListener;
}

function detect(handleMessage: MessageListener, tabId: number): void {
  handleMessage(
    { type: 'DETECTION_RESULT', data: detectionEvent(tabId) },
    { ...CONTENT_SENDER, tab: { id: tabId } },
    vi.fn(),
  );
}

describe('the extension sends no contribution event', () => {
  beforeEach(() => {
    requestedUrls.length = 0;
    (globalThis as Record<string, unknown>).fetch = recordingFetch;
    (chromeMock.tabs as unknown as { get: unknown }).get =
      vi.fn((id: number) => Promise.resolve({ id, url: 'https://example.test/some/page' }));
  });

  afterEach(() => {
    (globalThis as Record<string, unknown>).fetch = mockFetch;
  });

  it(`sends nothing to /api/v1/contribute over ${EARLIER_BATCH_SIZE + 1} detections with a stored opt-in`, async () => {
    storageData.contributeConsent = { ...STORED_OPT_IN };
    const handleMessage = await startWorker();

    // One entry per detection: the contribute requests seen so far.
    const afterEachDetection: number[] = [];
    for (let n = 1; n <= EARLIER_BATCH_SIZE + 1; n++) {
      detect(handleMessage, 100 + n);
      await settleAll();
      afterEachDetection.push(contributeRequests());
    }

    expect(afterEachDetection).toEqual(new Array(EARLIER_BATCH_SIZE + 1).fill(0));
    expect(storageData.contributeQueue).toBeUndefined();
  });

  it('queues and sends nothing when an agent session ends', async () => {
    const handleMessage = await startWorker();
    const tabId = 201;
    detect(handleMessage, tabId);
    await settleAll();

    // The opt-in is stored after the detection, so only the session end
    // could queue an event here.
    storageData.contributeConsent = { ...STORED_OPT_IN };
    chromeMock.tabs.onRemoved._fire(tabId);
    await settleAll();

    // The session ended and its report was written: the end-of-session path ran.
    expect(storageData.reports).toHaveLength(1);
    expect(storageData.contributeQueue).toBeUndefined();
    expect(contributeRequests()).toBe(0);
  });
});
