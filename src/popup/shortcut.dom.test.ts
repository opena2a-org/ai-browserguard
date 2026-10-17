/**
 * @vitest-environment jsdom
 *
 * Regression (#133): the popup header was the static string `Ctrl+Shift+K`,
 * so on macOS, where the manifest suggests `Command+Shift+K`, and for a user
 * who changed or removed the key, it named the wrong key. The header now
 * shows the key Chrome reports for the kill-switch command.
 */
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { renderKillSwitchShortcut, SHORTCUTS_PAGE } from './shortcut';

function commandsWith(shortcut: string | undefined) {
  return {
    getAll: async () => [
      { name: '_execute_action', shortcut: '' },
      { name: 'kill-switch', shortcut },
    ],
  };
}

describe('popup header kill switch key (#133)', () => {
  it('has no hard-coded key in the popup HTML', () => {
    const html = readFileSync(resolve(__dirname, 'index.html'), 'utf8');
    expect(html).not.toContain('Ctrl+Shift+K');
    expect(html).toContain('id="kill-switch-shortcut"');
  });

  it('shows the key Chrome reports for the kill switch', async () => {
    const el = document.createElement('span');
    // Chrome on macOS reports the key as Shift and Command symbols then K.
    const macKey = `${String.fromCodePoint(0x21e7)}${String.fromCodePoint(0x2318)}K`;
    await renderKillSwitchShortcut(el, commandsWith(macKey), () => {});
    expect(el.querySelector('kbd')?.textContent).toBe(macKey);
    expect(el.querySelector('button')).toBeNull();
  });

  it('says no key is set and opens the shortcuts page when none is bound', async () => {
    const open = vi.fn();
    const el = document.createElement('span');
    await renderKillSwitchShortcut(el, commandsWith(''), open);
    expect(el.querySelector('kbd')).toBeNull();
    const button = el.querySelector('button');
    expect(button?.textContent).toBe('No shortcut: set one');
    expect(button?.title).toBe(SHORTCUTS_PAGE);
    button?.click();
    expect(open).toHaveBeenCalledTimes(1);
  });

  it('treats an unreadable commands API as no key', async () => {
    const el = document.createElement('span');
    await renderKillSwitchShortcut(el, undefined, () => {});
    expect(el.querySelector('button')?.textContent).toBe('No shortcut: set one');

    const failing = { getAll: async () => { throw new Error('unavailable'); } };
    await renderKillSwitchShortcut(el, failing, () => {});
    expect(el.querySelector('kbd')).toBeNull();
  });
});
