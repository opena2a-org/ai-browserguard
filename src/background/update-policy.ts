/**
 * Applying a staged extension update (issue #68).
 *
 * Chrome downloads a new version as soon as the Web Store publishes it, but it
 * only activates it when the service worker is torn down. The keepalive alarm
 * keeps this worker alive for the whole browser session, so without an
 * `onUpdateAvailable` handler an install can run an old build (and an old
 * detection rule set) until the browser restarts, with nothing telling the user.
 *
 * Policy (enforcement continuity first):
 *   - reload at once only when the kill switch is not engaged AND no delegation
 *     is active: a reload mid-delegation would drop the in-page and CDP
 *     enforcement that delegation depends on;
 *   - otherwise hold the update as pending, report it to the popup (which offers
 *     a user-triggered reload), and re-check on every `delegation-check` alarm,
 *     so it applies within a minute of the last delegation ending.
 *
 * The gate is read only after the persisted state has loaded. At worker start
 * the in-memory defaults say "no delegation, kill switch off" until the load
 * resolves, and reading them early would reload straight through a delegation
 * that is active on disk. A failed load defers the update; it never reloads.
 */

export interface UpdateGate {
  killSwitchActive: boolean;
  hasActiveDelegation: boolean;
}

export interface PendingUpdate {
  /** Version Chrome staged, from `onUpdateAvailable` details; '' if absent. */
  version: string;
  /** ISO time the update was reported to this worker. */
  stagedAt: string;
}

export function canApplyUpdate(gate: UpdateGate): boolean {
  return !gate.killSwitchActive && !gate.hasActiveDelegation;
}

export interface UpdateControllerDeps {
  /** Resolves once persisted state is loaded. A rejection defers the update. */
  ready: () => Promise<void>;
  gate: () => UpdateGate;
  reload: () => void;
  now?: () => Date;
}

export interface UpdateController {
  /** `chrome.runtime.onUpdateAvailable` listener body. Resolves true if it reloaded. */
  onUpdateAvailable(details: { version?: unknown } | undefined): Promise<boolean>;
  /** Re-check a pending update against the gate. Resolves true if it reloaded. */
  applyIfIdle(): Promise<boolean>;
  /** User-triggered apply from the popup. Returns true if an update was pending. */
  applyNow(): boolean;
  getPending(): PendingUpdate | null;
}

export function createUpdateController(deps: UpdateControllerDeps): UpdateController {
  const now = deps.now ?? (() => new Date());
  let pending: PendingUpdate | null = null;

  async function applyIfIdle(): Promise<boolean> {
    if (!pending) return false;
    try {
      await deps.ready();
    } catch {
      return false;
    }
    if (!pending || !canApplyUpdate(deps.gate())) return false;
    deps.reload();
    return true;
  }

  return {
    onUpdateAvailable(details) {
      const version = typeof details?.version === 'string' ? details.version : '';
      pending = { version, stagedAt: now().toISOString() };
      return applyIfIdle();
    },
    applyIfIdle,
    applyNow() {
      if (!pending) return false;
      deps.reload();
      return true;
    },
    getPending() {
      return pending ? { ...pending } : null;
    },
  };
}
