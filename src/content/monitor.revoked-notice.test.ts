/**
 * @vitest-environment jsdom
 *
 * #70: an agent whose Full Access is revoked is told so on its next action in
 * the page, in the block reason when that action is blocked and in a notice of
 * its own when it is let through. The notice is given once.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import '../__tests__/setup';
import {
  startBoundaryMonitor,
  updateActiveRule,
  takeFullAccessRevokedNotice,
  fullAccessRevokedNoticeFor,
} from './monitor';
import { createRuleFromPreset } from '../delegation/rules';
import type { DelegationRule } from '../types/delegation';
import type { BoundaryViolation } from '../types/events';

function click(target: Element): boolean {
  return target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
}

describe('notice that Full Access was revoked (#70)', () => {
  let button: HTMLButtonElement;
  let onViolation: ReturnType<typeof vi.fn>;
  let onNotice: ReturnType<typeof vi.fn>;
  let stop: () => void;
  let fullAccess: DelegationRule;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-26T12:00:00Z'));
    document.body.innerHTML = '';
    button = document.createElement('button');
    document.body.appendChild(button);
    onViolation = vi.fn();
    onNotice = vi.fn();
    fullAccess = createRuleFromPreset('fullAccess');
    updateActiveRule(fullAccess);
    stop = startBoundaryMonitor(fullAccess, onViolation, vi.fn(), onNotice);
    takeFullAccessRevokedNotice();
  });

  afterEach(() => {
    stop();
    vi.useRealTimers();
  });

  /** Revoke as the content script does: new rule, then a restarted monitor. */
  function revokeTo(next: DelegationRule | null): void {
    updateActiveRule(next);
    stop();
    stop = startBoundaryMonitor(next, onViolation, vi.fn(), onNotice);
  }

  it('says so on the next action when that action is blocked', () => {
    revokeTo(createRuleFromPreset('readOnly'));
    expect(click(button)).toBe(false);
    const violation = onViolation.mock.calls[0][0] as BoundaryViolation;
    expect(violation.reason.startsWith(
      'Full Access was revoked; the Read-Only delegation applies now. ',
    )).toBe(true);
    expect(onNotice).not.toHaveBeenCalled();
  });

  it('says so in a notice when the next action is let through', () => {
    revokeTo(null);
    expect(click(button)).toBe(true);
    expect(onNotice).toHaveBeenCalledTimes(1);
    expect(onNotice).toHaveBeenCalledWith('Full Access was revoked; no delegation applies now.');
  });

  it('says so only once', () => {
    revokeTo(createRuleFromPreset('readOnly'));
    click(button);
    click(button);
    const second = onViolation.mock.calls[1][0] as BoundaryViolation;
    expect(second.reason).not.toContain('Full Access was revoked');
  });

  it('names an inactive rule left in force as no delegation', () => {
    revokeTo({ ...fullAccess, isActive: false });
    click(button);
    expect(onNotice).toHaveBeenCalledWith('Full Access was revoked; no delegation applies now.');
  });

  it('gives no notice when the rule changes to another live Full Access rule', () => {
    revokeTo(createRuleFromPreset('fullAccess'));
    click(button);
    expect(onNotice).not.toHaveBeenCalled();
    expect(takeFullAccessRevokedNotice()).toBeNull();
  });

  it('withdraws a pending notice when Full Access is granted again', () => {
    revokeTo(null);
    revokeTo(createRuleFromPreset('fullAccess'));
    click(button);
    expect(onNotice).not.toHaveBeenCalled();
  });

  it('gives no notice when the rule that changes was not Full Access', () => {
    revokeTo(createRuleFromPreset('readOnly'));
    takeFullAccessRevokedNotice();
    revokeTo(null);
    click(button);
    expect(onNotice).not.toHaveBeenCalled();
  });

  it('gives no notice when Full Access had already expired', () => {
    vi.setSystemTime(new Date(Date.parse(fullAccess.scope.timeBound!.expiresAt) + 1000));
    revokeTo(createRuleFromPreset('limited'));
    expect(takeFullAccessRevokedNotice()).toBeNull();
  });

  it('names the preset now in force', () => {
    expect(fullAccessRevokedNoticeFor(createRuleFromPreset('limited'))).toBe(
      'Full Access was revoked; the Limited Access delegation applies now.',
    );
  });
});
