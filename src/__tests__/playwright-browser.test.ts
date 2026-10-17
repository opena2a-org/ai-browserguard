/**
 * Regression (#133): `npm run smoke:export` on a machine without Playwright's
 * Chromium stopped with Playwright's generic install banner. The smoke now
 * checks the executable before it launches and names the install command.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join, sep } from 'path';
import { missingChromiumMessage, INSTALL_COMMAND } from '../../scripts/playwright-browser.mjs';

const EXE = join(sep, 'srv', 'ms-playwright', 'chromium-0000', 'chrome');
const ROOT = join(__dirname, '..', '..');

describe('Playwright Chromium pre-flight (#133)', () => {
  it('names the install command when the executable is missing', () => {
    const message = missingChromiumMessage(EXE, () => false);
    expect(message).toContain(EXE);
    expect(message).toContain('Install it with: npx playwright install chromium');
    expect(INSTALL_COMMAND).toBe('npx playwright install chromium');
  });

  it('passes when the executable exists', () => {
    expect(missingChromiumMessage(EXE, (p) => p === EXE)).toBeNull();
  });

  it('runs before the export smoke launches the browser', () => {
    const src = readFileSync(join(ROOT, 'scripts', 'smoke-export.mjs'), 'utf8');
    const check = src.indexOf('missingChromiumMessage(chromium.executablePath())');
    const launch = src.indexOf('chromium.launchPersistentContext(');
    expect(check).toBeGreaterThan(-1);
    expect(launch).toBeGreaterThan(check);
  });

  it('is named in the docs that list the export smoke', () => {
    for (const doc of ['CONTRIBUTING.md', join('docs', 'testing', 'release-smoke.md')]) {
      expect(readFileSync(join(ROOT, doc), 'utf8')).toContain(INSTALL_COMMAND);
    }
  });
});
