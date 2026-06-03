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
import { describe, it, expect, beforeEach, vi } from 'vitest';
import '../__tests__/setup';
import { startBoundaryMonitor } from './monitor';
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
});
