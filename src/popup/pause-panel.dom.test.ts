/**
 * @vitest-environment jsdom
 *
 * Popup pause panel (#71): the two ways to start a pause, the countdown and
 * Resume for each live pause, and the pause history.
 */
import { describe, it, expect, vi } from 'vitest';
import { renderPausePanel, updatePauseCountdowns, formatPauseRemaining } from './pause-panel';
import type { PausePanelInput } from './pause-panel';
import { createPause } from '../delegation/pause';
import type { GuardPause, PauseLogEntry } from '../delegation/pause';

const NOW = Date.parse('2026-10-05T12:00:00.000Z');

function pause(request: { scope: string; host: string | null; minutes: number | null }, id: string): GuardPause {
  const r = createPause(request, NOW, id);
  if (!r.ok) throw new Error(r.reason);
  return r.pause;
}

function render(overrides: Partial<PausePanelInput> = {}) {
  const container = document.createElement('div');
  const actions = { onPause: vi.fn(), onResume: vi.fn() };
  renderPausePanel(container, {
    currentHost: 'dashboard.example.com',
    pauses: [],
    log: [],
    killSwitchActive: false,
    error: null,
    now: NOW,
    ...overrides,
  }, actions);
  return { container, actions };
}

function buttonByText(container: HTMLElement, text: string): HTMLButtonElement {
  const button = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === text);
  if (!button) throw new Error(`no button "${text}"`);
  return button;
}

describe('pause panel (#71)', () => {
  it('offers a site pause for the current site with 15, 60 minutes or until resumed', () => {
    const { container, actions } = render();
    expect(container.textContent).toContain('On dashboard.example.com');
    const selects = container.querySelectorAll('select');
    expect(Array.from(selects[0].options).map((o) => o.textContent)).toEqual(['15 minutes', '60 minutes', 'Until I resume']);

    selects[0].value = 'resume';
    buttonByText(container, 'Pause on this site').click();
    expect(actions.onPause).toHaveBeenCalledWith({ scope: 'site', host: 'dashboard.example.com', minutes: null });
  });

  it('offers a pause everywhere, time-boxed only', () => {
    const { container, actions } = render();
    const selects = container.querySelectorAll('select');
    expect(Array.from(selects[1].options).map((o) => o.textContent)).toEqual(['15 minutes', '60 minutes']);
    selects[1].value = '60';
    buttonByText(container, 'Pause everywhere').click();
    expect(actions.onPause).toHaveBeenCalledWith({ scope: 'all', host: null, minutes: 60 });
  });

  it('on a page that is not a website, only the pause everywhere is offered', () => {
    const { container } = render({ currentHost: null });
    expect(container.textContent).toContain('Open a website in this tab to pause the guard on it.');
    expect(() => buttonByText(container, 'Pause on this site')).toThrow();
    buttonByText(container, 'Pause everywhere');
  });

  it('shows each live pause with a countdown and a Resume button', () => {
    const site = pause({ scope: 'site', host: 'dashboard.example.com', minutes: 60 }, 'site-1');
    const open = pause({ scope: 'site', host: 'other.test', minutes: null }, 'site-2');
    const all = pause({ scope: 'all', host: null, minutes: 15 }, 'all-1');
    const { container, actions } = render({ pauses: [open, site, all] });

    const rows = Array.from(container.querySelectorAll('.pause-active')).map((r) => r.textContent);
    expect(rows).toEqual([
      'Paused everywhere · 15:00 leftResume',
      'Paused on dashboard.example.com · 60:00 leftResume',
      'Paused on other.test · until you resumeResume',
    ]);
    // The site is already paused, and so is everywhere: no second start offered.
    expect(() => buttonByText(container, 'Pause on this site')).toThrow();
    expect(() => buttonByText(container, 'Pause everywhere')).toThrow();

    (container.querySelectorAll('.pause-resume-btn')[1] as HTMLButtonElement).click();
    expect(actions.onResume).toHaveBeenCalledWith('site-1');
  });

  it('the countdown ticks and reports when a pause has run out', () => {
    const all = pause({ scope: 'all', host: null, minutes: 15 }, 'all-1');
    const { container } = render({ pauses: [all] });
    expect(updatePauseCountdowns(container, NOW + 61_000)).toBe(false);
    expect(container.querySelector('.pause-countdown')?.textContent).toBe(' · 13:59 left');
    expect(updatePauseCountdowns(container, NOW + 15 * 60_000)).toBe(true);
    expect(container.querySelector('.pause-countdown')?.textContent).toBe(' · 0:00 left');
  });

  it('offers no pause while the kill switch is on', () => {
    const { container } = render({ killSwitchActive: true });
    expect(container.textContent).toContain('Pausing is unavailable while the kill switch is on.');
    expect(container.querySelectorAll('select')).toHaveLength(0);
  });

  it('shows why a request failed', () => {
    const { container } = render({ error: 'A pause everywhere lasts 15 or 60 minutes.' });
    const alert = container.querySelector('[role="alert"]');
    expect(alert?.textContent).toBe('A pause everywhere lasts 15 or 60 minutes.');
  });

  it('lists recent pauses: what was unguarded, and how it ended', () => {
    const ended: PauseLogEntry = {
      ...pause({ scope: 'site', host: 'dashboard.example.com', minutes: 15 }, 'p1'),
      endedAt: '2026-10-05T12:15:00.000Z',
      endReason: 'expired',
    };
    const live: PauseLogEntry = { ...pause({ scope: 'all', host: null, minutes: 60 }, 'p2'), endedAt: null, endReason: null };
    const { container } = render({ log: [live, ended] });
    const items = Array.from(container.querySelectorAll('.pause-history li')).map((li) => li.textContent);
    expect(items).toHaveLength(2);
    expect(items[0]).toMatch(/^Everywhere · .+ to now · still paused$/);
    expect(items[1]).toMatch(/^dashboard\.example\.com · .+ to .+ · ended on time$/);
  });

  it('writes a hostile host as text, never as markup', () => {
    const { container } = render({ currentHost: '<img src=x onerror=alert(1)>' });
    expect(container.querySelector('img')).toBeNull();
  });
});

describe('formatPauseRemaining', () => {
  it('formats minutes and seconds, and the open-ended case', () => {
    expect(formatPauseRemaining('2026-10-05T12:59:05.000Z', NOW)).toBe('59:05 left');
    expect(formatPauseRemaining('2026-10-05T11:00:00.000Z', NOW)).toBe('0:00 left');
    expect(formatPauseRemaining(null, NOW)).toBe('until you resume');
  });
});
