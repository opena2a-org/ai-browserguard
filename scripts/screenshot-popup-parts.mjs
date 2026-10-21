/**
 * The two parts of the popup that are filled at run time, drawn for a store
 * capture (#161).
 *
 * scripts/generate-screenshots.mjs loads the built popup in a plain page,
 * where `chrome` is not defined, so the popup script stops before it renders
 * anything and a capture shows the static HTML with the staged state written
 * into it. Two parts of the popup are empty in that HTML and filled only by
 * the script: the key bound to the kill switch beside the Kill Switch button
 * (src/popup/shortcut.ts) and the content of the Pause the guard panel
 * (src/popup/pause-panel.ts). Without them a capture showed a header with
 * nothing between the Kill Switch and Settings buttons and a panel with its
 * heading only, which the popup never shows.
 *
 * `drawPopupRuntimeParts` builds the elements those renderers build for a
 * popup with no live pause, no pause history and no pause error;
 * src/__tests__/screenshot-popup-parts.test.ts compares its output with
 * theirs. It runs inside the page through `page.evaluate`, so it refers to
 * nothing outside itself.
 */

/**
 * @typedef {object} PopupRuntimeState
 * @property {string} shortcut the key shown beside the Kill Switch button
 * @property {string | null} currentHost hostname of the page in the active
 *   tab, or null when it is not a website
 * @property {boolean} [killSwitchActive]
 */

/**
 * Fill `#kill-switch-shortcut` and `#pause-content` of the popup document the
 * way the popup renders them for `state`.
 *
 * @param {PopupRuntimeState} state
 */
export function drawPopupRuntimeParts(state) {
  const shortcut = document.getElementById('kill-switch-shortcut');
  const kbd = document.createElement('kbd');
  kbd.textContent = state.shortcut;
  shortcut.replaceChildren(kbd);
  shortcut.title = 'Kill switch shortcut';

  const content = document.getElementById('pause-content');
  content.replaceChildren();

  const note = (text) => {
    const p = document.createElement('p');
    p.className = 'pause-note';
    p.textContent = text;
    return p;
  };

  const startRow = (text, options, selected, selectLabel, buttonText) => {
    const row = document.createElement('div');
    row.className = 'pause-row';
    const label = document.createElement('span');
    label.className = 'pause-label';
    label.textContent = text;
    const select = document.createElement('select');
    select.className = 'form-input pause-duration';
    select.setAttribute('aria-label', selectLabel);
    for (const minutes of options) {
      const option = document.createElement('option');
      option.value = minutes === null ? 'resume' : String(minutes);
      option.textContent = minutes === null ? 'Until I resume' : `${minutes} minutes`;
      option.selected = minutes === selected;
      select.appendChild(option);
    }
    const button = document.createElement('button');
    button.className = 'btn btn-secondary btn-sm';
    button.textContent = buttonText;
    row.appendChild(label);
    row.appendChild(select);
    row.appendChild(button);
    return row;
  };

  if (state.killSwitchActive) {
    content.appendChild(note('Pausing is unavailable while the kill switch is on.'));
    return;
  }
  if (state.currentHost === null) {
    content.appendChild(note('Open a website in this tab to pause the guard on it.'));
  } else {
    const host = state.currentHost;
    content.appendChild(startRow(`On ${host}`, [15, 60, null], 60, `How long to pause on ${host}`, 'Pause on this site'));
  }
  content.appendChild(startRow('Every site', [15, 60], 15, 'How long to pause everywhere', 'Pause everywhere'));
}
