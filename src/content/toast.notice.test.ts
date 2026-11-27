/**
 * @vitest-environment jsdom
 *
 * #70: the first action let through after Full Access was revoked gets a
 * one-line notice of its own, carrying the AI Browser Guard name.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import '../__tests__/setup';
import { showNoticeToast } from './toast';

function inner(): HTMLElement | null {
  const host = document.getElementById('abg-toast-container') as
    | (HTMLElement & { _inner?: HTMLElement })
    | null;
  return host?._inner ?? null;
}

function shown(): Element[] {
  return Array.from(inner()?.querySelectorAll('.abg-toast:not(.abg-toast-exit)') ?? []);
}

describe('a notice that is not a block (#70)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    document.getElementById('abg-toast-container')?.remove();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('shows the line under the AI Browser Guard name', () => {
    showNoticeToast('Full Access was revoked; no delegation applies now.');
    const [toast] = shown();
    expect(toast.querySelector('.abg-toast-brand')?.textContent).toBe('AI Browser Guard');
    expect(toast.querySelector('.abg-toast-what')?.textContent).toBe(
      'Full Access was revoked; no delegation applies now.',
    );
    expect(toast.querySelector('.abg-toast-btn-allow')).toBeNull();
  });

  it('offers Settings when given and is dismissed after 8 seconds', () => {
    const open = vi.fn();
    showNoticeToast('Full Access was revoked; no delegation applies now.', open);
    const settings = shown()[0].querySelector('.abg-toast-btn-settings') as HTMLButtonElement;
    expect(settings.textContent).toBe('Settings');
    showNoticeToast('second');
    vi.advanceTimersByTime(8000);
    expect(shown()).toHaveLength(0);
  });
});
