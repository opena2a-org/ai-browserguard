/**
 * @vitest-environment jsdom
 *
 * Regression (#133): identical consecutive block notices each took a slot, so
 * a burst of six synthetic clicks under Read-Only filled the three-notice stack
 * with copies and pushed out the one notice that differed. A notice identical
 * to the newest one now counts on it.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import '../__tests__/setup';
import { showBlockedToast } from './toast';

const URL_A = 'https://example.com/page';
const REASON = 'Not permitted under the Read-Only delegation.';

function inner(): HTMLElement | null {
  const host = document.getElementById('abg-toast-container') as
    | (HTMLElement & { _inner?: HTMLElement })
    | null;
  return host?._inner ?? null;
}

/** The "what" line of each notice on screen, oldest first. */
function noticeLines(): string[] {
  return Array.from(inner()?.querySelectorAll('.abg-toast:not(.abg-toast-exit) .abg-toast-what') ?? []).map(
    (el) => el.textContent ?? '',
  );
}

function block(capability: string, url = URL_A, reason = REASON): () => void {
  return showBlockedToast({ capability, url, reason, onOpenSettings: () => {} });
}

describe('identical block notices count on one notice (#133)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    document.getElementById('abg-toast-container')?.remove();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('shows a burst of six identical clicks as one notice with a count', () => {
    for (let i = 0; i < 6; i++) block('click');
    expect(noticeLines()).toEqual(['Blocked click. ×6']);
  });

  it('keeps a different notice on screen through a burst', () => {
    block('submit-form');
    for (let i = 0; i < 6; i++) block('click');
    expect(noticeLines()).toEqual(['Blocked form submission.', 'Blocked click. ×6']);
  });

  it('starts a new notice when the block differs from the newest one', () => {
    block('click');
    block('click', 'https://other.example/');
    block('click');
    expect(noticeLines()).toEqual(['Blocked click.', 'Blocked click.', 'Blocked click.']);
  });

  it('restarts the dismiss timer on a repeat', () => {
    block('click');
    vi.advanceTimersByTime(6000);
    block('click');
    vi.advanceTimersByTime(6000);
    expect(noticeLines()).toEqual(['Blocked click. ×2']);
    vi.advanceTimersByTime(3000);
    expect(noticeLines()).toEqual([]);
  });

  it('starts a new notice once the counted one is dismissed', () => {
    const dismiss = block('click');
    block('click');
    dismiss();
    block('click');
    expect(noticeLines()).toEqual(['Blocked click.']);
  });
});
