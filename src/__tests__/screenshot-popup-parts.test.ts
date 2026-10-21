/**
 * @vitest-environment jsdom
 *
 * Regression (#161): scripts/generate-screenshots.mjs captures the built popup
 * in a plain page without the chrome.* APIs, where the popup script renders
 * nothing, so the two parts the script fills at run time stayed empty in the
 * captures: the kill switch key beside the Kill Switch button and the content
 * of the Pause the guard panel. The captures showed a header with nothing
 * between the Kill Switch and Settings buttons and a panel with its heading
 * only, which the popup never shows. scripts/screenshot-popup-parts.mjs draws
 * both for each staged state; these cases compare what it draws with what the
 * popup's own renderers draw for the same state.
 */
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { drawPopupRuntimeParts } from '../../scripts/screenshot-popup-parts.mjs';
import { renderKillSwitchShortcut } from '../popup/shortcut';
import { renderPausePanel } from '../popup/pause-panel';

const ROOT = resolve(__dirname, '../..');
const MANIFEST_KEY: string = JSON.parse(readFileSync(resolve(ROOT, 'manifest.json'), 'utf-8'))
  .commands['kill-switch'].suggested_key.default;

interface StagedState {
  currentHost: string | null;
  killSwitchActive: boolean;
}

const STATES: Array<[string, StagedState]> = [
  ['a website in the active tab', { currentHost: 'app.example.com', killSwitchActive: false }],
  ['no website in the active tab', { currentHost: null, killSwitchActive: false }],
  ['the kill switch on', { currentHost: 'app.example.com', killSwitchActive: true }],
];

/** The popup's HTML, which the generator loads from the build. */
function loadPopupDocument(): void {
  const html = readFileSync(resolve(ROOT, 'src/popup/index.html'), 'utf-8');
  document.body.innerHTML = html.slice(html.indexOf('<body>') + '<body>'.length, html.indexOf('</body>'));
}

/** What src/popup/shortcut.ts and src/popup/pause-panel.ts render for `state`. */
async function renderedByPopup(state: StagedState): Promise<{ shortcut: HTMLElement; pause: HTMLElement }> {
  const shortcut = document.createElement('span');
  const commands = { getAll: async () => [{ name: 'kill-switch', shortcut: MANIFEST_KEY }] };
  await renderKillSwitchShortcut(shortcut, commands, () => {});
  const pause = document.createElement('div');
  renderPausePanel(
    pause,
    { ...state, pauses: [], log: [], error: null, now: Date.now() },
    { onPause: vi.fn(), onResume: vi.fn() },
  );
  return { shortcut, pause };
}

function selectedValues(el: HTMLElement): string[] {
  return [...el.querySelectorAll('select')].map((select) => select.value);
}

describe('popup parts drawn for the store captures (#161)', () => {
  it.each(STATES)(
    'with %s, draws the kill switch key and the Pause the guard content as the popup renders them',
    async (_name, state) => {
      loadPopupDocument();
      drawPopupRuntimeParts({ shortcut: MANIFEST_KEY, ...state });
      const expected = await renderedByPopup(state);

      const shortcut = document.getElementById('kill-switch-shortcut')!;
      expect(shortcut.innerHTML).toBe(expected.shortcut.innerHTML);
      expect(shortcut.querySelector('kbd')?.textContent).toBe(MANIFEST_KEY);
      expect(shortcut.title).toBe(expected.shortcut.title);

      const pause = document.getElementById('pause-content')!;
      expect(pause.innerHTML).not.toBe('');
      expect(pause.innerHTML).toBe(expected.pause.innerHTML);
      expect(selectedValues(pause)).toEqual(selectedValues(expected.pause));
    },
  );

  it('shows the pause rows beside a website, and only the note while the kill switch is on', () => {
    loadPopupDocument();
    drawPopupRuntimeParts({ shortcut: MANIFEST_KEY, currentHost: 'app.example.com' });
    const pause = document.getElementById('pause-content')!;
    expect([...pause.querySelectorAll('.pause-label')].map((el) => el.textContent)).toEqual([
      'On app.example.com',
      'Every site',
    ]);
    expect([...pause.querySelectorAll('button')].map((el) => el.textContent)).toEqual([
      'Pause on this site',
      'Pause everywhere',
    ]);

    drawPopupRuntimeParts({ shortcut: MANIFEST_KEY, currentHost: 'app.example.com', killSwitchActive: true });
    expect(pause.textContent).toBe('Pausing is unavailable while the kill switch is on.');
    expect(pause.querySelector('button')).toBeNull();
  });

  it('the generator draws them for each capture, with the key the manifest suggests', () => {
    const generator = readFileSync(resolve(ROOT, 'scripts/generate-screenshots.mjs'), 'utf-8');
    expect(generator).toContain("import { drawPopupRuntimeParts } from './screenshot-popup-parts.mjs'");
    expect(generator).toContain(".commands['kill-switch'].suggested_key.default");
    expect(generator).toContain(
      'await page.evaluate(drawPopupRuntimeParts, { shortcut: KILL_SWITCH_KEY, ...popupState })',
    );
    const captures = generator.split('await screenshot(').slice(1);
    expect(captures).toHaveLength(4);
    const states = captures.map((call) => /\n {2}\}, (\{[^\n]*\})\);\n/.exec(call)?.[1]);
    expect(states).toEqual([
      "{ currentHost: 'app.example.com' }",
      "{ currentHost: 'app.example.com' }",
      "{ currentHost: 'app.example.com' }",
      "{ currentHost: 'app.example.com', killSwitchActive: true }",
    ]);
  });
});
