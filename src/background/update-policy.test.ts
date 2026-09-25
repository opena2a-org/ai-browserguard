/**
 * Staged-update policy (issue #68): a staged update reloads the extension only
 * when no delegation is active and the kill switch is not engaged, and only
 * after the persisted state has loaded.
 */
import { describe, it, expect, vi } from 'vitest';
import { canApplyUpdate, createUpdateController, type UpdateGate } from './update-policy';

const IDLE: UpdateGate = { killSwitchActive: false, hasActiveDelegation: false };

function controller(gate: () => UpdateGate, ready: () => Promise<void> = () => Promise.resolve()) {
  const reload = vi.fn();
  const c = createUpdateController({ ready, gate, reload, now: () => new Date('2026-09-25T08:00:00Z') });
  return { c, reload };
}

describe('canApplyUpdate', () => {
  it('is true only when disarmed and idle', () => {
    expect(canApplyUpdate(IDLE)).toBe(true);
    expect(canApplyUpdate({ killSwitchActive: true, hasActiveDelegation: false })).toBe(false);
    expect(canApplyUpdate({ killSwitchActive: false, hasActiveDelegation: true })).toBe(false);
    expect(canApplyUpdate({ killSwitchActive: true, hasActiveDelegation: true })).toBe(false);
  });
});

describe('createUpdateController', () => {
  it('reloads at once when an update arrives while idle', async () => {
    const { c, reload } = controller(() => IDLE);
    await expect(c.onUpdateAvailable({ version: '0.7.1' })).resolves.toBe(true);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('never reloads while a delegation is active; holds the update as pending', async () => {
    const gate = { ...IDLE, hasActiveDelegation: true };
    const { c, reload } = controller(() => gate);
    await expect(c.onUpdateAvailable({ version: '0.7.1' })).resolves.toBe(false);
    await expect(c.applyIfIdle()).resolves.toBe(false);
    expect(reload).not.toHaveBeenCalled();
    expect(c.getPending()).toEqual({ version: '0.7.1', stagedAt: '2026-09-25T08:00:00.000Z' });
  });

  it('never reloads while the kill switch is engaged', async () => {
    const gate = { ...IDLE, killSwitchActive: true };
    const { c, reload } = controller(() => gate);
    await c.onUpdateAvailable({ version: '0.7.1' });
    await c.applyIfIdle();
    expect(reload).not.toHaveBeenCalled();
  });

  it('applies the pending update on the first re-check after the last delegation ends', async () => {
    const gate = { ...IDLE, hasActiveDelegation: true };
    const { c, reload } = controller(() => gate);
    await c.onUpdateAvailable({ version: '0.7.1' });
    expect(reload).not.toHaveBeenCalled();
    gate.hasActiveDelegation = false;
    await expect(c.applyIfIdle()).resolves.toBe(true);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('reads the gate only after the persisted state has loaded', async () => {
    // In-memory defaults read "idle" until the load lands an active delegation.
    let loaded = false;
    let release!: () => void;
    const load = new Promise<void>((r) => { release = r; });
    const ready = () => load.then(() => { loaded = true; });
    const gate = () => (loaded ? { ...IDLE, hasActiveDelegation: true } : IDLE);
    const { c, reload } = controller(gate, ready);
    const result = c.onUpdateAvailable({ version: '0.7.1' });
    expect(reload).not.toHaveBeenCalled();
    release();
    await expect(result).resolves.toBe(false);
    expect(reload).not.toHaveBeenCalled();
  });

  it('defers, never reloads, when the state load fails', async () => {
    const { c, reload } = controller(() => IDLE, () => Promise.reject(new Error('storage')));
    await expect(c.onUpdateAvailable({ version: '0.7.1' })).resolves.toBe(false);
    expect(reload).not.toHaveBeenCalled();
    expect(c.getPending()?.version).toBe('0.7.1');
  });

  it('does nothing without a pending update', async () => {
    const { c, reload } = controller(() => IDLE);
    await expect(c.applyIfIdle()).resolves.toBe(false);
    expect(c.applyNow()).toBe(false);
    expect(reload).not.toHaveBeenCalled();
    expect(c.getPending()).toBeNull();
  });

  it('applyNow reloads a pending update even mid-delegation (the user chose it)', async () => {
    const { c, reload } = controller(() => ({ ...IDLE, hasActiveDelegation: true }));
    await c.onUpdateAvailable({ version: '0.7.1' });
    expect(c.applyNow()).toBe(true);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('records an empty version when Chrome omits it', async () => {
    const { c } = controller(() => ({ ...IDLE, killSwitchActive: true }));
    await c.onUpdateAvailable(undefined);
    expect(c.getPending()?.version).toBe('');
  });
});
