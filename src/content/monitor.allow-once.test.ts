/**
 * @vitest-environment jsdom
 *
 * Regression: the toast's "Allow once" must work for MONITOR-path blocks (F-B).
 *
 * The grant used to land only in the MAIN-world interceptor's override set,
 * but the commonest in-page block — a synthetic click/type/submit under a
 * Read-Only rule — is issued by the ISOLATED-world boundary monitor, which
 * consulted no override at all. The user clicked "Allow once" and the very
 * same action stayed blocked: an inert control on the exact surface where it
 * is offered most. These tests fail on the pre-fix code (the grant entry
 * point does not exist there, and the re-dispatched action stays blocked).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import '../__tests__/setup';
import { startBoundaryMonitor, grantMonitorAllowOnce, clearMonitorAllowOnce } from './monitor';
import { createRuleFromPreset } from '../delegation/rules';

describe('monitor-path "Allow once" (F-B)', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('lets exactly one otherwise-blocked action through after a grant, then blocks again', () => {
    const rule = createRuleFromPreset('readOnly'); // submit-form is blocked
    const onViolation = vi.fn();
    const onAction = vi.fn();
    const stop = startBoundaryMonitor(rule, onViolation, onAction);

    const pageHandler = vi.fn();
    document.addEventListener('submit', pageHandler, { capture: true });
    const form = document.createElement('form');
    document.body.appendChild(form);

    // Baseline: blocked.
    const first = new Event('submit', { bubbles: true, cancelable: true });
    form.dispatchEvent(first);
    expect(onViolation).toHaveBeenCalledTimes(1);
    expect(first.defaultPrevented).toBe(true);
    expect(pageHandler).not.toHaveBeenCalled();

    // The user clicks "Allow once" on the toast for this exact block.
    grantMonitorAllowOnce('submit-form', window.location.href);

    // The re-attempted action passes — once.
    const second = new Event('submit', { bubbles: true, cancelable: true });
    form.dispatchEvent(second);
    expect(onViolation).toHaveBeenCalledTimes(1); // no new violation
    expect(second.defaultPrevented).toBe(false);
    expect(pageHandler).toHaveBeenCalledTimes(1);
    const allowedEvents = onAction.mock.calls
      .map((c) => c[0] as { type: string; description: string })
      .filter((e) => e.type === 'action-allowed');
    expect(allowedEvents).toHaveLength(1);
    expect(allowedEvents[0].description).toContain('one-time override');

    // The override is consumed: the next identical action is blocked again.
    const third = new Event('submit', { bubbles: true, cancelable: true });
    form.dispatchEvent(third);
    expect(onViolation).toHaveBeenCalledTimes(2);
    expect(third.defaultPrevented).toBe(true);
    expect(pageHandler).toHaveBeenCalledTimes(1);

    document.removeEventListener('submit', pageHandler, { capture: true });
    stop();
  });

  it('the kill switch purges pending grants — a stale override cannot outlive the emergency', () => {
    // Mirrors the MAIN-world interceptor's allowedOnce.clear() on activation:
    // a grant issued before the emergency must not let an action through a
    // monitor re-armed while (or after) the switch is active.
    const rule = createRuleFromPreset('readOnly');
    const onViolation = vi.fn();
    const onAction = vi.fn();
    let stop = startBoundaryMonitor(rule, onViolation, onAction);

    grantMonitorAllowOnce('submit-form', window.location.href);

    // Kill switch fires: monitor torn down, grants purged (the content
    // script's KILL_SWITCH_ACTIVATE handler calls clearMonitorAllowOnce).
    stop();
    clearMonitorAllowOnce();

    // The monitor is re-armed (e.g. a delegation update pushed later).
    stop = startBoundaryMonitor(rule, onViolation, onAction);
    const form = document.createElement('form');
    document.body.appendChild(form);
    const event = new Event('submit', { bubbles: true, cancelable: true });
    form.dispatchEvent(event);

    // The pre-emergency grant must NOT apply.
    expect(onViolation).toHaveBeenCalledTimes(1);
    expect(event.defaultPrevented).toBe(true);
    stop();
  });

  it('a grant for one capability does not leak to another', () => {
    const rule = createRuleFromPreset('readOnly');
    const onViolation = vi.fn();
    const onAction = vi.fn();
    const stop = startBoundaryMonitor(rule, onViolation, onAction);

    grantMonitorAllowOnce('submit-form', window.location.href);

    // A blocked capability the user did NOT approve stays blocked.
    const input = document.createElement('input');
    document.body.appendChild(input);
    const typeEvent = new Event('input', { bubbles: true, cancelable: true });
    input.dispatchEvent(typeEvent);
    expect(onViolation).toHaveBeenCalledTimes(1);
    expect(typeEvent.defaultPrevented).toBe(true);

    stop();
  });
});
