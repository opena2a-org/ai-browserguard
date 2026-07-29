/**
 * Regression: a detected agent survives an MV3 worker restart while its tab
 * lives (field-test F-P, root cause of "in-page enforcement is unreachable").
 *
 * The in-memory agent/session maps die with every worker restart, and the old
 * load path force-ended every un-ended stored session as 'agent-disconnected'.
 * Net effect in the field: navigate (or idle) once, the worker recycles, the
 * popup says "No agents detected", and there is no agent card left to grant
 * Read-Only from — the block engine works but can never be armed. On the
 * pre-fix code the first test fails (no agents after restart, session ended);
 * the second pins that the honest disconnect path still ends sessions whose
 * tab is actually gone.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { chromeMock, storageData } from '../__tests__/setup';

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

async function importWorker(): Promise<Listener> {
  chromeMock.runtime.onMessage.addListener.mockClear();
  await import('./index');
  // Let the initial loadPersistedState settle.
  for (let i = 0; i < 6; i++) await flush();
  const calls = chromeMock.runtime.onMessage.addListener.mock.calls;
  return calls[calls.length - 1][0] as Listener;
}

async function queryAgents(handleMessage: Listener): Promise<{ detectedAgents: unknown[] }> {
  const resp = vi.fn();
  handleMessage({ type: 'STATUS_QUERY', data: {} }, POPUP_SENDER, resp);
  await flush();
  return resp.mock.calls[0][0] as { detectedAgents: unknown[] };
}

beforeEach(() => {
  vi.resetModules();
});

describe('F-P: agent registry survives a worker restart', () => {
  it('rehydrates the agent and keeps its session live while the tab exists on the same origin', async () => {
    // The tab is alive across the restart, still on the agent's origin.
    (chromeMock.tabs as unknown as { get: unknown }).get =
      vi.fn((id: number) => Promise.resolve({ id, url: 'https://example.test/some/page' }));

    let handleMessage = await importWorker();
    const detResp = vi.fn();
    handleMessage({ type: 'DETECTION_RESULT', data: detectionEvent() }, CONTENT_SENDER, detResp);
    for (let i = 0; i < 4; i++) await flush();
    expect((await queryAgents(handleMessage)).detectedAgents).toHaveLength(1);

    // MV3 worker restart: module state dies, storage survives.
    vi.resetModules();
    handleMessage = await importWorker();

    // Pre-fix: the popup shows "No agents detected" and the session was
    // force-ended 'agent-disconnected' — nothing left to delegate to.
    const agents = (await queryAgents(handleMessage)).detectedAgents as Array<{ id: string }>;
    expect(agents).toHaveLength(1);
    expect(agents[0]).toMatchObject({ id: 'agent-1' });

    const sessions = storageData.sessions as Array<{ endedAt: string | null; endReason: string | null }>;
    expect(sessions).toHaveLength(1);
    expect(sessions[0].endedAt).toBeNull();
  });

  it('does NOT rehydrate onto a reused tab id showing a different origin — and never aims the kill switch at it', async () => {
    // Chrome reuses tab ids across browser restarts: after a restart, id 42
    // can belong to an unrelated restored tab (the user's bank). Rehydrating
    // by id alone would pin the stale agent onto that innocent tab — which
    // the kill switch then CLOSES. Identity is existence + origin.
    (chromeMock.tabs as unknown as { get: unknown }).get =
      vi.fn((id: number) => Promise.resolve({ id, url: 'https://example.test/some/page' }));

    let handleMessage = await importWorker();
    const detResp = vi.fn();
    handleMessage({ type: 'DETECTION_RESULT', data: detectionEvent() }, CONTENT_SENDER, detResp);
    for (let i = 0; i < 4; i++) await flush();

    // Browser restart: id 42 now belongs to an unrelated site.
    (chromeMock.tabs as unknown as { get: unknown }).get =
      vi.fn((id: number) => Promise.resolve({ id, url: 'https://bank.example/accounts' }));

    vi.resetModules();
    handleMessage = await importWorker();

    expect((await queryAgents(handleMessage)).detectedAgents).toHaveLength(0);
    const sessions = storageData.sessions as Array<{ endedAt: string | null; endReason: string | null }>;
    expect(sessions[0].endedAt).not.toBeNull();
    expect(sessions[0].endReason).toBe('agent-disconnected');
  });

  it('drops malformed registry entries instead of loading garbage agents', async () => {
    (chromeMock.tabs as unknown as { get: unknown }).get =
      vi.fn((id: number) => Promise.resolve({ id, url: 'https://example.test/some/page' }));

    // Corrupt/partial entries alongside a valid one: only the valid entry may
    // rehydrate; nothing may throw; the junk is pruned from storage.
    storageData.activeAgentRegistry = {
      'not-a-number': { agent: { id: 'x', type: 'y', originUrl: 'https://a.test/' }, sessionId: 's0' },
      '7': { agent: {}, sessionId: 's1' },
      '8': { agent: { id: 'a', type: 'b', originUrl: 'https://example.test/' } }, // no sessionId
      '9': 'garbage-string',
      '42': {
        agent: {
          id: 'agent-1', type: 'playwright', detectionMethods: ['cdp-connection'],
          confidence: 'high', detectedAt: new Date().toISOString(),
          originUrl: 'https://example.test/', observedCapabilities: [], isActive: true,
        },
        sessionId: 'valid-session',
      },
    };

    const handleMessage = await importWorker();
    const agents = (await queryAgents(handleMessage)).detectedAgents as Array<{ id: string }>;
    expect(agents).toHaveLength(1);
    expect(agents[0]).toMatchObject({ id: 'agent-1' });

    const registry = storageData.activeAgentRegistry as Record<string, unknown>;
    expect(Object.keys(registry)).toEqual(['42']);
  });

  it('still ends the session honestly when the tab is gone at restart', async () => {
    (chromeMock.tabs as unknown as { get: unknown }).get =
      vi.fn((id: number) => Promise.resolve({ id, url: 'https://example.test/some/page' }));

    let handleMessage = await importWorker();
    const detResp = vi.fn();
    handleMessage({ type: 'DETECTION_RESULT', data: detectionEvent() }, CONTENT_SENDER, detResp);
    for (let i = 0; i < 4; i++) await flush();

    // The tab does NOT survive the restart.
    (chromeMock.tabs as unknown as { get: unknown }).get =
      vi.fn(() => Promise.reject(new Error('No tab with id')));

    vi.resetModules();
    handleMessage = await importWorker();

    expect((await queryAgents(handleMessage)).detectedAgents).toHaveLength(0);
    const sessions = storageData.sessions as Array<{ endedAt: string | null; endReason: string | null }>;
    expect(sessions).toHaveLength(1);
    expect(sessions[0].endedAt).not.toBeNull();
    expect(sessions[0].endReason).toBe('agent-disconnected');
  });
});
