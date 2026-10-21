/**
 * @vitest-environment jsdom
 *
 * Regression (#166): in the 360 px popup the label of the "Pause on this site"
 * row read "On app.e..." for app.example.com. `.pause-label` was `flex: 1;
 * min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space:
 * nowrap`, so after the duration select and the button took their width the
 * label kept about 67 px and cut the hostname, which was then only in the
 * select's aria-label.
 *
 * jsdom lays nothing out, so this test applies the popup's stylesheet to the
 * panel the popup renders and reads the computed declarations: the label may
 * not be cut (no hidden overflow, no ellipsis, no single-line text), it may
 * break a hostname with no hyphen in it, and its row wraps with the select and
 * the button grouped, so they move to the next line together and the label
 * keeps the row's width. scripts/smoke-popup-layout.mjs measures the same rows
 * in Chromium at the popup's width.
 */
import { describe, it, expect, vi, beforeAll } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { renderPausePanel } from './pause-panel';

const HOST = 'app.example.com';

beforeAll(() => {
  const style = document.createElement('style');
  style.textContent = readFileSync(resolve(__dirname, 'styles.css'), 'utf-8');
  document.head.appendChild(style);
});

function renderPanel(): HTMLElement {
  const container = document.createElement('div');
  container.id = 'pause-content';
  document.body.replaceChildren(container);
  renderPausePanel(
    container,
    { currentHost: HOST, pauses: [], log: [], killSwitchActive: false, error: null, now: Date.now() },
    { onPause: vi.fn(), onResume: vi.fn() },
  );
  return container;
}

function labelFor(container: HTMLElement, text: string): HTMLElement {
  const label = [...container.querySelectorAll<HTMLElement>('.pause-label')].find((el) => el.textContent === text);
  if (!label) throw new Error(`no label "${text}"`);
  return label;
}

describe('Pause the guard row labels at the popup width (#166)', () => {
  it.each([`On ${HOST}`, 'Every site'])('"%s" is not cut short', (text) => {
    const style = getComputedStyle(labelFor(renderPanel(), text));
    expect(style.overflow).not.toBe('hidden');
    expect(style.textOverflow).not.toBe('ellipsis');
    expect(style.whiteSpace).not.toBe('nowrap');
    expect(style.overflowWrap).toBe('anywhere');
  });

  it.each([`On ${HOST}`, 'Every site'])(
    'the row of "%s" wraps, with the select and the button grouped after the label',
    (text) => {
      const label = labelFor(renderPanel(), text);
      const row = label.parentElement!;
      expect(row.classList.contains('pause-row')).toBe(true);
      expect(getComputedStyle(row).flexWrap).toBe('wrap');

      expect(row.children).toHaveLength(2);
      expect(row.firstElementChild).toBe(label);
      const controls = row.lastElementChild as HTMLElement;
      expect([...controls.children].map((el) => el.tagName)).toEqual(['SELECT', 'BUTTON']);
      expect(getComputedStyle(controls).display).toBe('flex');
    },
  );
});
