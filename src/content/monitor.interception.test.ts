/**
 * @vitest-environment jsdom
 *
 * DOM-level enforcement test for the boundary monitor's interception handler.
 *
 * #29 enforcement: a blocked agent action must not reach the page's own
 * handlers. The interceptor runs in the capture phase on `document`, so
 * `stopPropagation()` alone is insufficient — it still lets other listeners
 * registered on the SAME node at the SAME phase run. The handler uses
 * `stopImmediatePropagation()` so a blocked synthetic event is truly halted.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import '../__tests__/setup';
import { startBoundaryMonitor, getMonitorState } from './monitor';
import { createRuleFromPreset } from '../delegation/rules';

describe('boundary monitor interception (DOM)', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('halts a blocked synthetic event before the page\'s own same-node listener runs', () => {
    const rule = createRuleFromPreset('readOnly'); // submit-form is blocked
    const onViolation = vi.fn();
    const onAction = vi.fn();
    const stop = startBoundaryMonitor(rule, onViolation, onAction);

    // The page's own handler, registered on the SAME node (document) at the SAME
    // phase (capture) AFTER the monitor's handler. With plain stopPropagation this
    // would still fire; stopImmediatePropagation must prevent it.
    const pageHandler = vi.fn();
    document.addEventListener('submit', pageHandler, { capture: true });

    const form = document.createElement('form');
    document.body.appendChild(form);

    const event = new Event('submit', { bubbles: true, cancelable: true });
    form.dispatchEvent(event);

    expect(event.isTrusted).toBe(false); // synthetic = agent-attributed
    expect(onViolation).toHaveBeenCalledTimes(1);
    expect(event.defaultPrevented).toBe(true);
    expect(pageHandler).not.toHaveBeenCalled();

    document.removeEventListener('submit', pageHandler, { capture: true });
    stop();
  });

  it('lets an allowed action reach the page (no over-blocking)', () => {
    const rule = createRuleFromPreset('fullAccess'); // click allowed
    const onViolation = vi.fn();
    const onAction = vi.fn();
    const stop = startBoundaryMonitor(rule, onViolation, onAction);

    const pageHandler = vi.fn();
    document.addEventListener('click', pageHandler, { capture: true });

    const button = document.createElement('button');
    document.body.appendChild(button);

    const event = new Event('click', { bubbles: true, cancelable: true });
    button.dispatchEvent(event);

    expect(onViolation).not.toHaveBeenCalled();
    expect(onAction).toHaveBeenCalledTimes(1);
    expect(event.defaultPrevented).toBe(false);
    expect(pageHandler).toHaveBeenCalledTimes(1);

    document.removeEventListener('click', pageHandler, { capture: true });
    stop();
  });

  // #122: each blocked event was also pushed to a list of up to 50 in the
  // monitor state, which no code read. A block is handed to onViolation; the
  // state keeps the two counts.
  it('counts a blocked event and keeps no list of blocked events', () => {
    const stop = startBoundaryMonitor(createRuleFromPreset('readOnly'), vi.fn(), vi.fn());

    const button = document.createElement('button');
    document.body.appendChild(button);
    button.dispatchEvent(new Event('click', { bubbles: true, cancelable: true }));

    const state = getMonitorState();
    stop();
    expect(state.blockedCount).toBe(1);
    expect(Object.keys(state).sort()).toEqual(['activeRule', 'allowedCount', 'blockedCount', 'isMonitoring']);

    const architecture = readFileSync(resolve(__dirname, '../..', 'docs/architecture.md'), 'utf-8');
    expect(architecture).not.toContain('recentViolations');
  });
});

/**
 * #122: the monitor acts on the rule in its tab and on whether an event is
 * trusted. It is told nothing about a detected agent, so a page's own script
 * that dispatches an event is blocked like an agent's. The README's scope of
 * enforcement must say so.
 */
describe('a page\'s own scripted event under Read-Only, with no agent in the tab', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const SCRIPTED_EVENTS: Array<[string, () => Event]> = [
    ['click', () => new MouseEvent('click', { bubbles: true, cancelable: true })],
    ['keydown', () => new KeyboardEvent('keydown', { bubbles: true, cancelable: true })],
    ['input', () => new Event('input', { bubbles: true, cancelable: true })],
    ['submit', () => new Event('submit', { bubbles: true, cancelable: true })],
  ];

  it.each(SCRIPTED_EVENTS)('blocks a %s event the page dispatches from a timer', (type, create) => {
    const onViolation = vi.fn();
    const stop = startBoundaryMonitor(createRuleFromPreset('readOnly'), onViolation, vi.fn());

    const form = document.createElement('form');
    const input = document.createElement('input');
    form.appendChild(input);
    document.body.appendChild(form);
    const pageHandler = vi.fn();
    form.addEventListener(type, pageHandler);

    const event = create();
    setTimeout(() => (type === 'submit' ? form : input).dispatchEvent(event), 1000);
    vi.advanceTimersByTime(1000);

    expect(event.defaultPrevented).toBe(true);
    expect(pageHandler).not.toHaveBeenCalled();
    expect(onViolation).toHaveBeenCalledTimes(1);
    stop();
  });

  it('the README says so where it states the scope of enforcement, and links the page that says it in full', () => {
    const readme = readFileSync(resolve(__dirname, '../..', 'README.md'), 'utf-8');
    const scope = readme.indexOf('> **Scope of enforcement.**');
    expect(scope, 'the README must keep its "Scope of enforcement" note').toBeGreaterThanOrEqual(0);
    const start = readme.indexOf('\n\n', scope) + 2;
    expect(
      readme.startsWith('> **Tabs with no detected agent.**', start),
      'the README must follow its "Scope of enforcement" note with the "Tabs with no detected agent" note',
    ).toBe(true);
    const note = readme.slice(start, readme.indexOf('\n\n', start));

    expect(note).toContain('**Tabs with no detected agent.**');
    expect(note).toContain("a page's own scripted `click`, `keydown`, `input` or `submit` event can be blocked there");
    expect(note).toContain('(docs/enforcement-scope.md#tabs-with-no-detected-agent)');

    const page = readFileSync(resolve(__dirname, '../..', 'docs/enforcement-scope.md'), 'utf-8');
    const heading = page.indexOf('\n## Tabs with no detected agent\n');
    expect(heading, 'docs/enforcement-scope.md must keep its "Tabs with no detected agent" section').toBeGreaterThanOrEqual(0);
    const end = page.indexOf('\n## ', heading + 1);
    const section = page.slice(heading, end === -1 ? undefined : end);
    expect(section).toContain(
      'it blocks an untrusted `click`, `keydown`, `input` or `submit` event that the rule does not permit, whether an agent or the page\'s own script dispatched it',
    );
  });
});
