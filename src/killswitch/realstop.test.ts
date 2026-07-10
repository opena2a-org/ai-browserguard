/**
 * ADR-008 regression guard: the kill switch must perform a real stop (close the
 * agent's tab) and record only outcomes that occurred.
 *
 * These assertions FAIL on the v0.4.2 code, which set `cdpTerminated:true`
 * unconditionally and never closed a tab.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { executeBackgroundKillSwitch } from './index';

describe('executeBackgroundKillSwitch — real hard stop + truthful outcome', () => {
  beforeEach(() => {
    (chrome.tabs as unknown as { remove: unknown }).remove = vi.fn(() => Promise.resolve());
    (chrome.tabs as unknown as { query: unknown }).query = vi.fn(() => Promise.resolve([{ id: 1 }]));
  });

  it('closes every agent-controlled tab and records them in closedTabIds', async () => {
    const remove = (chrome.tabs as unknown as { remove: ReturnType<typeof vi.fn> }).remove;
    const ev = await executeBackgroundKillSwitch('button', ['agent-a'], [], [10, 20]);
    expect(remove).toHaveBeenCalledWith(10);
    expect(remove).toHaveBeenCalledWith(20);
    expect(ev.closedTabIds).toEqual([10, 20]);
  });

  it('records only outcomes that occurred: no cdpTerminated / automationFlagsCleared fields', async () => {
    const ev = await executeBackgroundKillSwitch('button', [], [], []);
    expect(ev).not.toHaveProperty('cdpTerminated');
    expect(ev).not.toHaveProperty('automationFlagsCleared');
    expect(ev.closedTabIds).toEqual([]);
    expect(ev.pageRealmCleanupDispatched).toBe(true);
  });

  it('a tab that fails to close is not counted as closed (accurate outcome)', async () => {
    (chrome.tabs as unknown as { remove: unknown }).remove = vi.fn((id: number) =>
      id === 10 ? Promise.reject(new Error('tab gone')) : Promise.resolve(),
    );
    const ev = await executeBackgroundKillSwitch('button', [], [], [10, 20]);
    expect(ev.closedTabIds).toEqual([20]);
  });
});
