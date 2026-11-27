/**
 * @vitest-environment jsdom
 *
 * #70: an agent whose paste or typing into a form or editor is denied, and
 * which then presses Enter, Cmd/Ctrl+Return or clicks the submit button, sends
 * whatever the field held. The monitor holds a submit that follows a denied
 * text input in the same sequence, and its reason says the input did not reach
 * the page.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import '../__tests__/setup';
import {
  startBoundaryMonitor,
  updateActiveRule,
  grantMonitorAllowOnce,
  clearMonitorAllowOnce,
  DENIED_INPUT_SEQUENCE_MS,
  HELD_SUBMIT_REASON,
} from './monitor';
import { createRuleFromPreset } from '../delegation/rules';
import type { DelegationRule } from '../types/delegation';
import type { BoundaryViolation } from '../types/events';

/** A rule that blocks typing but permits clicks and form submissions. */
function noTypingRule(): DelegationRule {
  const rule = createRuleFromPreset('fullAccess');
  rule.scope.actionRestrictions = rule.scope.actionRestrictions.map((r) => ({
    ...r,
    action: r.capability === 'type-text' ? 'block' : 'allow',
  }));
  return rule;
}

function enter(init: KeyboardEventInit = {}): KeyboardEvent {
  return new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true, ...init });
}

describe('a submit after a denied text input (#70)', () => {
  let form: HTMLFormElement;
  let field: HTMLInputElement;
  let submitButton: HTMLButtonElement;
  let onViolation: ReturnType<typeof vi.fn>;
  let stop: () => void;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-26T12:00:00Z'));
    clearMonitorAllowOnce();
    document.body.innerHTML = '';
    form = document.createElement('form');
    field = document.createElement('input');
    submitButton = document.createElement('button');
    submitButton.type = 'submit';
    form.append(field, submitButton);
    document.body.appendChild(form);
    onViolation = vi.fn();
    stop = startBoundaryMonitor(noTypingRule(), onViolation, vi.fn());
  });

  afterEach(() => {
    stop();
    vi.useRealTimers();
  });

  function denyInput(): void {
    const input = new Event('input', { bubbles: true, cancelable: true });
    field.dispatchEvent(input);
    expect(input.defaultPrevented).toBe(true);
  }

  function lastViolation(): BoundaryViolation {
    return onViolation.mock.calls[onViolation.mock.calls.length - 1][0] as BoundaryViolation;
  }

  it('lets the submit through when no input was denied', () => {
    const click = new MouseEvent('click', { bubbles: true, cancelable: true });
    submitButton.dispatchEvent(click);
    const submit = new Event('submit', { bubbles: true, cancelable: true });
    form.dispatchEvent(submit);

    expect(click.defaultPrevented).toBe(false);
    expect(submit.defaultPrevented).toBe(false);
    expect(onViolation).not.toHaveBeenCalled();
  });

  it.each([
    ['a submit button click', () => new MouseEvent('click', { bubbles: true, cancelable: true }), 'button', 'click'],
    ['a submit event', () => new Event('submit', { bubbles: true, cancelable: true }), 'form', 'submit-form'],
  ] as const)('holds %s after a denied input and says the input did not land', (_, create, on, capability) => {
    denyInput();
    const pageHandler = vi.fn();
    form.addEventListener(on === 'form' ? 'submit' : 'click', pageHandler);

    const event = create();
    (on === 'form' ? form : submitButton).dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    expect(pageHandler).not.toHaveBeenCalled();
    expect(lastViolation().attemptedAction).toBe(capability);
    expect(lastViolation().reason).toBe(HELD_SUBMIT_REASON);
    expect(HELD_SUBMIT_REASON).toContain('did not reach the page');
  });

  it('holds Enter and Cmd+Return after a denied keystroke, and says why', () => {
    const typed = new KeyboardEvent('keydown', { key: 'h', bubbles: true, cancelable: true });
    field.dispatchEvent(typed);
    expect(typed.defaultPrevented).toBe(true);
    expect(lastViolation().reason).not.toBe(HELD_SUBMIT_REASON);

    for (const key of [enter(), enter({ metaKey: true }), enter({ ctrlKey: true })]) {
      field.dispatchEvent(key);
      expect(key.defaultPrevented).toBe(true);
      expect(lastViolation().reason).toBe(HELD_SUBMIT_REASON);
    }
  });

  it('holds a click on a send button outside any form, as in a chat editor', () => {
    const editor = document.createElement('div');
    editor.contentEditable = 'true';
    const send = document.createElement('button');
    send.type = 'button';
    const icon = document.createElement('span');
    send.appendChild(icon);
    document.body.append(editor, send);

    const paste = new Event('input', { bubbles: true, cancelable: true });
    editor.dispatchEvent(paste);
    expect(paste.defaultPrevented).toBe(true);

    const click = new MouseEvent('click', { bubbles: true, cancelable: true });
    icon.dispatchEvent(click);
    expect(click.defaultPrevented).toBe(true);
    expect(lastViolation().reason).toBe(HELD_SUBMIT_REASON);
  });

  it('does not hold a click that submits nothing, nor Shift+Enter', () => {
    denyInput();
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    const plain = document.createElement('button');
    plain.type = 'button';
    form.append(checkbox, plain);

    for (const target of [checkbox, plain, field]) {
      const click = new MouseEvent('click', { bubbles: true, cancelable: true });
      target.dispatchEvent(click);
      expect(click.defaultPrevented).toBe(false);
    }
    // Shift+Enter is a keystroke the rule blocks as typing, not a held submit.
    const shiftEnter = enter({ shiftKey: true });
    field.dispatchEvent(shiftEnter);
    expect(lastViolation().reason).not.toBe(HELD_SUBMIT_REASON);
  });

  it('ends the sequence once a text input lands', () => {
    denyInput();
    grantMonitorAllowOnce('type-text', window.location.href);
    const retried = new Event('input', { bubbles: true, cancelable: true });
    field.dispatchEvent(retried);
    expect(retried.defaultPrevented).toBe(false);

    const submit = new Event('submit', { bubbles: true, cancelable: true });
    form.dispatchEvent(submit);
    expect(submit.defaultPrevented).toBe(false);
  });

  it('ends the sequence on a trusted user event, a rule change, or after the sequence time', () => {
    const submitAfter = () => {
      const submit = new Event('submit', { bubbles: true, cancelable: true });
      form.dispatchEvent(submit);
      return submit.defaultPrevented;
    };

    denyInput();
    vi.advanceTimersByTime(DENIED_INPUT_SEQUENCE_MS + 1);
    expect(submitAfter()).toBe(false);

    denyInput();
    updateActiveRule(noTypingRule());
    expect(submitAfter()).toBe(false);

    // jsdom cannot dispatch a trusted event: hand one to the monitor's
    // listeners directly, as the browser would for the user's own click.
    stop();
    const listen = vi.spyOn(document, 'addEventListener');
    stop = startBoundaryMonitor(noTypingRule(), onViolation, vi.fn());
    const clickListeners = listen.mock.calls
      .filter(([type]) => type === 'click')
      .map(([, listener]) => listener as (e: Event) => void);
    listen.mockRestore();
    denyInput();
    for (const listener of clickListeners) listener({ type: 'click', isTrusted: true, target: field } as unknown as Event);
    vi.advanceTimersByTime(1000); // past the user-gesture grace period
    expect(submitAfter()).toBe(false);

    // Within the sequence, every submit is held, not only the first.
    denyInput();
    vi.advanceTimersByTime(DENIED_INPUT_SEQUENCE_MS - 1);
    expect(submitAfter()).toBe(true);
    expect(submitAfter()).toBe(true);
  });

  it('docs/enforcement-scope.md says a submit after a denied input is held, and why', () => {
    const page = readFileSync(resolve(__dirname, '../..', 'docs/enforcement-scope.md'), 'utf-8');
    const heading = page.indexOf('\n### A submit after a denied input\n');
    expect(heading, 'docs/enforcement-scope.md must have a "A submit after a denied input" section').toBeGreaterThanOrEqual(0);
    const end = page.indexOf('\n#', heading + 1);
    const section = page.slice(heading, end === -1 ? undefined : end);
    expect(section).toContain(HELD_SUBMIT_REASON);
    expect(section).toContain(`${DENIED_INPUT_SEQUENCE_MS / 1000} seconds`);
    expect(section).toContain('decision of the agent\'s host');
  });
});
