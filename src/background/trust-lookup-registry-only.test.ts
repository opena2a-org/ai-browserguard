/**
 * Regression: detecting an agent asks the Registry about its type and nothing
 * else, even on a profile an earlier version left with the removed AIM lookup
 * setting switched on.
 *
 * The earlier AIM lookup sent the detected framework name to the AIM server
 * with no credential, and a question about a framework with no organization in
 * it is the Registry's to answer. The lookup, its setting and its base URL are
 * gone. An older profile still holds `aimLookupEnabled: true` in storage, which
 * is why this test seeds it.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { chromeMock, storageData } from '../__tests__/setup';

const POPUP_SENDER = { id: 'test-id', url: 'chrome-extension://test-id/dist/popup/index.html' };
const CONTENT_SENDER = {
  id: 'test-id',
  tab: { id: 42 },
  frameId: 0,
  url: 'https://example.test/',
  origin: 'https://example.test',
};

type Listener = (msg: unknown, sender: unknown, sendResponse: (r: unknown) => void) => boolean;

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function detectionEvent(type = 'playwright', agentId = 'agent-1') {
  return {
    id: `det-${agentId}`,
    timestamp: new Date().toISOString(),
    methods: ['cdp-connection'],
    confidence: 'high',
    agent: {
      id: agentId,
      type,
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

// Answers every request. The registry search returns a "scanned" package
// (trust level 3, classification "known", score 0.6). Any other URL gets a
// record with a perfect score, so a stray lookup would also move the score.
const requestedUrls: string[] = [];
const mockFetch = vi.fn((input: unknown): Promise<unknown> => {
  const url = String(input);
  requestedUrls.push(url);
  const body = url.includes('/api/v1/registry/search')
    ? [{ trustLevel: 3, name: 'playwright', displayName: 'Playwright' }]
    : { trustScore: 1, displayName: 'Not the registry' };
  return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });
});

async function importWorker(): Promise<Listener> {
  chromeMock.runtime.onMessage.addListener.mockClear();
  await import('./index');
  for (let i = 0; i < 6; i++) await flush();
  const calls = chromeMock.runtime.onMessage.addListener.mock.calls;
  return calls[calls.length - 1][0] as Listener;
}

beforeEach(() => {
  vi.resetModules();
  requestedUrls.length = 0;
  (globalThis as Record<string, unknown>).fetch = mockFetch;
  (chromeMock.tabs as unknown as { get: unknown }).get =
    vi.fn((id: number) => Promise.resolve({ id, url: 'https://example.test/some/page' }));
});

describe('trust lookup on detection', () => {
  it('asks only the Registry, even when an older profile has the AIM lookup setting on', async () => {
    storageData.settings = {
      aimLookupEnabled: true,
      aimBaseUrl: 'https://aim.opena2a.org',
      registryLookupEnabled: true,
    };

    const handleMessage = await importWorker();
    handleMessage({ type: 'DETECTION_RESULT', data: detectionEvent() }, CONTENT_SENDER, vi.fn());
    for (let i = 0; i < 10; i++) await flush();

    expect(requestedUrls).toEqual(['https://api.oa2a.org/api/v1/registry/search?q=playwright']);

    const resp = vi.fn();
    handleMessage({ type: 'STATUS_QUERY', data: {} }, POPUP_SENDER, resp);
    await flush();
    const agents = (resp.mock.calls[0][0] as { detectedAgents: Array<{ trustScore?: number; label?: string }> })
      .detectedAgents;
    expect(agents).toHaveLength(1);
    // The Registry's score alone, not averaged with a second source.
    expect(agents[0].trustScore).toBe(0.6);
    expect(agents[0].label).toBe('Playwright');
  });

  it('makes no request while the Registry lookup is left at its default (off)', async () => {
    storageData.settings = { aimLookupEnabled: true };

    const handleMessage = await importWorker();
    handleMessage({ type: 'DETECTION_RESULT', data: detectionEvent() }, CONTENT_SENDER, vi.fn());
    for (let i = 0; i < 10; i++) await flush();

    expect(requestedUrls).toEqual([]);
  });

  it('makes no request after the stored setting is set back to false (#148)', async () => {
    // The popup has no switch for this lookup, so the privacy copy says it is
    // turned off by setting registryLookupEnabled to false in the stored
    // settings. This is that write, made straight to storage.
    storageData.settings = { registryLookupEnabled: true };
    const handleMessage = await importWorker();
    const detect = (type: string, tabId: number) =>
      handleMessage(
        { type: 'DETECTION_RESULT', data: detectionEvent(type, `agent-${tabId}`) },
        { ...CONTENT_SENDER, tab: { id: tabId } },
        vi.fn(),
      );

    detect('playwright', 42);
    for (let i = 0; i < 10; i++) await flush();
    // A new agent type is asked about while the setting is on, so the registry
    // client's per-type cache cannot be why the last detection asks nothing.
    detect('puppeteer', 43);
    for (let i = 0; i < 10; i++) await flush();
    expect(requestedUrls).toEqual([
      'https://api.oa2a.org/api/v1/registry/search?q=playwright',
      'https://api.oa2a.org/api/v1/registry/search?q=puppeteer',
    ]);

    storageData.settings = { registryLookupEnabled: false };
    detect('selenium', 44);
    for (let i = 0; i < 10; i++) await flush();
    expect(requestedUrls).toHaveLength(2);
  });
});
