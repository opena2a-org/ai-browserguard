/**
 * Pre-flight for the export smoke, which runs in Playwright's Chromium.
 *
 * `npm run smoke:export` launches Playwright's Chromium, which `npm ci` does
 * not download. Without it the launch stopped with Playwright's generic
 * install banner. The smoke checks the executable first and names the one
 * command that installs it.
 */
import { existsSync } from 'fs';

export const INSTALL_COMMAND = 'npx playwright install chromium';

/**
 * The message to print when Playwright's Chromium is not installed, or null
 * when the executable exists.
 *
 * @param {string} executablePath what `chromium.executablePath()` returns
 * @param {(path: string) => boolean} [exists]
 * @returns {string | null}
 */
export function missingChromiumMessage(executablePath, exists = existsSync) {
  if (executablePath && exists(executablePath)) return null;
  return [
    "This smoke runs in Playwright's Chromium, which is not installed:",
    `  ${executablePath || '(Playwright reported no path)'}`,
    `Install it with: ${INSTALL_COMMAND}`,
  ].join('\n');
}
