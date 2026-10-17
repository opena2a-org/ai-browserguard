/**
 * The kill switch key in the popup header (#133).
 *
 * The header named `Ctrl+Shift+K` on every platform, while the manifest
 * suggests `Command+Shift+K` on macOS, and the user or Chrome can change or
 * unbind it. The header reads the key Chrome reports for the kill-switch
 * command, as the detection notification does, and says when none is set.
 */

export const SHORTCUTS_PAGE = 'chrome://extensions/shortcuts';

type CommandsApi = { getAll?: () => Promise<Array<{ name?: string; shortcut?: string }>> };

/** The key bound to the kill switch, or '' when none is or it cannot be read. */
export async function killSwitchShortcut(commands: CommandsApi | undefined): Promise<string> {
  if (typeof commands?.getAll !== 'function') return '';
  try {
    const all = await commands.getAll();
    return all.find((c) => c.name === 'kill-switch')?.shortcut ?? '';
  } catch {
    return '';
  }
}

/**
 * Fill `el` with the kill switch key, or with "No shortcut" and a button that
 * opens chrome://extensions/shortcuts when no key is bound.
 */
export async function renderKillSwitchShortcut(
  el: HTMLElement,
  commands: CommandsApi | undefined,
  openShortcutsPage: () => void,
): Promise<void> {
  const shortcut = await killSwitchShortcut(commands);
  if (shortcut) {
    const kbd = document.createElement('kbd');
    kbd.textContent = shortcut;
    el.replaceChildren(kbd);
    el.title = 'Kill switch shortcut';
    return;
  }
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'header-shortcut-set';
  button.textContent = 'No shortcut: set one';
  button.title = SHORTCUTS_PAGE;
  button.addEventListener('click', openShortcutsPage);
  el.replaceChildren(button);
  el.removeAttribute('title');
}
