/**
 * Regression: KILL_SWITCH_RESET must win the race against the worker's async
 * state load.
 *
 * The MV3 background worker registers its message listener synchronously at
 * start, but loads persisted state (including the latched kill switch)
 * asynchronously. If a KILL_SWITCH_RESET is handled before that load resolves,
 * the load can reassign `state.killSwitch` from storage AFTER the reset cleared
 * it — re-arming a latch the user just released and locking them in a "killed"
 * state with no in-product recovery (observed live 2026-07-27, only escapable by
 * reinstalling the extension).
 *
 * This test drives that exact interleaving: it holds the `killSwitchState` read
 * open, fires the reset while the load is in flight, then releases the read. The
 * fix (ensureReady gate + authoritative clear) makes the reset await the load
 * and clear last, so the final state — in memory and persisted — is inactive.
 * On the pre-fix code the reset runs before the load and is clobbered, so the
 * final state reports killed and this test fails.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { chromeMock, storageData } from '../__tests__/setup';

const POPUP_SENDER = { id: 'test-id', url: 'chrome-extension://test-id/dist/popup/index.html' };

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

type Listener = (msg: unknown, sender: unknown, sendResponse: (r: unknown) => void) => boolean;

beforeEach(() => {
  vi.resetModules();
});

describe('KILL_SWITCH_RESET vs. async state load', () => {
  it('clears the latch even when the reset is handled before the load resolves', async () => {
    // Seed a persisted, ACTIVE kill switch (the latched "killed" state on disk).
    await chromeMock.storage.local.set({
      killSwitchState: {
        isActive: true,
        lastEvent: { id: 'k1', closedTabIds: [1, 2], terminatedAgentIds: [], revokedTokenIds: [], pageRealmCleanupDispatched: true, trigger: 'keyboard-shortcut', timestamp: '2026-07-28T01:31:51.702Z' },
        lastActivatedAt: '2026-07-28T01:31:51.702Z',
      },
    });

    // Hold the `killSwitchState` read open so loadPersistedState hangs exactly
    // at `state.killSwitch = await getKillSwitchState()`. Other reads resolve
    // normally, capturing their value at call time (as real storage does).
    const originalGet = chromeMock.storage.local.get.getMockImplementation()!;
    let releaseLoad!: () => void;
    const loadGate = new Promise<void>((r) => { releaseLoad = r; });
    chromeMock.storage.local.get.mockImplementation((keys, cb) => {
      const gated = keys === 'killSwitchState'
        || (Array.isArray(keys) && keys.includes('killSwitchState'));
      const snapshot = originalGet(keys, cb) as Promise<Record<string, unknown>>;
      return gated ? loadGate.then(() => snapshot) : snapshot;
    });

    // Import the worker fresh so initialize() runs against the gated read.
    chromeMock.runtime.onMessage.addListener.mockClear();
    await import('./index');
    const calls = chromeMock.runtime.onMessage.addListener.mock.calls;
    const handleMessage = calls[calls.length - 1][0] as Listener;

    // Fire the reset while the load is still in flight.
    const resetResponse = vi.fn();
    handleMessage({ type: 'KILL_SWITCH_RESET', data: {} }, POPUP_SENDER, resetResponse);

    // Now let the load complete (it reassigns state.killSwitch from storage).
    releaseLoad();
    await flush();
    await flush();

    // Query the state the popup would see.
    const statusResponse = vi.fn();
    handleMessage({ type: 'STATUS_QUERY', data: {} }, POPUP_SENDER, statusResponse);
    await flush();

    // The reset must have won: state and disk both report inactive.
    expect(resetResponse).toHaveBeenCalledWith(expect.objectContaining({ success: true }));
    expect(statusResponse).toHaveBeenCalledWith(
      expect.objectContaining({ killSwitchActive: false }),
    );
    expect((storageData.killSwitchState as { isActive: boolean }).isActive).toBe(false);
  });
});
