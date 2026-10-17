/**
 * @vitest-environment jsdom
 *
 * The in-page block notices stack three high, a new notice drops the oldest,
 * and a block identical to the newest notice counts on it. Under a Read-Only
 * delegation an in-page agent's click, typing (a keydown and an input) and
 * form submission are four blocks in a row, and the fourth, the form
 * submission, must still show its notice: afterwards the stack holds the
 * click, the two text inputs on one notice and the form submission, newest.
 * `npm run smoke:notices` checks the same sequence in a real browser.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import '../__tests__/setup';
import { showBlockedToast } from './toast';
import { checkBoundary } from './monitor';
import { createRuleFromPreset } from '../delegation/rules';
import type { AgentCapability } from '../types/agent';

const PAGE_URL = 'http://127.0.0.1:8080/';
const rule = createRuleFromPreset('readOnly');

/** Show the notice the content script shows for a monitor block of `capability`. */
function block(capability: AgentCapability): void {
  const result = checkBoundary(capability, PAGE_URL, rule);
  expect(result.allowed, `Read-Only must block ${capability}`).toBe(false);
  showBlockedToast({
    capability,
    url: PAGE_URL,
    reason: result.reason,
    onAllowOnce: vi.fn(),
    onOpenSettings: vi.fn(),
  });
}

/** The element the notices are appended to, kept on the host of the closed shadow root. */
function stack(): HTMLElement {
  const host = document.getElementById('abg-toast-container') as (HTMLElement & { _inner?: HTMLElement }) | null;
  expect(host?._inner, 'the notice container must exist').toBeDefined();
  return host!._inner!;
}

const what = (notice: Element): string => notice.querySelector('.abg-toast-what')?.textContent ?? '';

describe('in-page block notice stack', () => {
  beforeEach(() => {
    document.getElementById('abg-toast-container')?.remove();
  });

  it('shows the form submission after a click and two text inputs, the text inputs counted on one notice', () => {
    for (const capability of ['click', 'type-text', 'type-text', 'submit-form'] as const) block(capability);

    const notices = Array.from(stack().children);
    expect(notices).toHaveLength(3);
    expect(notices.map(what)).toEqual(['Blocked click.', 'Blocked text input. ×2', 'Blocked form submission.']);
    // A text input may be allowed once; a form submission may not.
    expect(notices[1].querySelector('.abg-toast-btn-allow')).not.toBeNull();
    expect(notices[2].querySelector('.abg-toast-btn-allow')).toBeNull();
    expect(notices[2].querySelector('.abg-toast-btn-settings')?.textContent).toBe('Settings');
  });

  it('keeps the three newest of twenty notices, the newest last', () => {
    const sequence: AgentCapability[] = [];
    for (let i = 0; i < 19; i++) sequence.push(i % 2 === 0 ? 'click' : 'type-text');
    sequence.push('submit-form');

    for (const [i, capability] of sequence.entries()) {
      block(capability);
      expect(stack().children, `after notice ${i + 1}`).toHaveLength(Math.min(i + 1, 3));
      expect(what(stack().lastElementChild!), `notice ${i + 1} is the newest`).toBe(
        capability === 'submit-form' ? 'Blocked form submission.' : capability === 'click' ? 'Blocked click.' : 'Blocked text input.',
      );
    }

    expect(Array.from(stack().children).map(what)).toEqual(['Blocked text input.', 'Blocked click.', 'Blocked form submission.']);
  });
});
