/**
 * Developer mode in the profile of the live smokes that reload the extension.
 *
 * `npm run smoke:downloads` and `npm run smoke:devtools` write their settings
 * to chrome.storage and reload the extension so the background loads them. On
 * Chrome 154 a reload in a profile with Developer mode off leaves an unpacked
 * extension disabled, so both smokes stopped with "Timed out after waiting
 * 20000ms" while waiting for the extension's worker. These cases pin
 * scripts/smoke-profile.mjs, which turns Developer mode on, and that every
 * smoke that reloads the extension calls it on its profile before it starts
 * its browser.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { readdirSync, readFileSync } from 'fs';
import { join, sep } from 'path';
import { enableDeveloperMode } from '../../scripts/smoke-profile.mjs';

const PROFILE = join(sep, 'srv', 'smoke', 'profile');

interface DeveloperPrivate {
  updateProfileConfiguration: (update: { inDeveloperMode: boolean }) => Promise<void>;
  getProfileConfiguration: () => Promise<{ inDeveloperMode: boolean }>;
}

/** The setting as a profile holds it: off until chrome://extensions turns it on. */
function developerModeSetting(): { on: boolean; api: DeveloperPrivate } {
  const setting: { on: boolean; api: DeveloperPrivate } = {
    on: false,
    api: {
      updateProfileConfiguration: async (update) => { setting.on = update.inDeveloperMode; },
      getProfileConfiguration: async () => ({ inDeveloperMode: setting.on }),
    },
  };
  return setting;
}

/** A launcher whose browser runs what the page evaluates against `developerPrivate`. */
function fakeLauncher(developerPrivate: DeveloperPrivate) {
  const steps: string[] = [];
  const page = {
    goto: async (url: string) => { steps.push(`goto ${url}`); },
    evaluate: async (fn: () => unknown) => {
      steps.push('evaluate');
      (globalThis as Record<string, unknown>).chrome = { developerPrivate };
      return fn();
    },
  };
  const browser = {
    newPage: async () => page,
    close: async () => { steps.push('close'); },
  };
  const launch = vi.fn(async (_options: Record<string, unknown>) => {
    steps.push('launch');
    return browser;
  });
  return { launcher: { launch }, launch, steps };
}

const chromeMock = (globalThis as Record<string, unknown>).chrome;
afterEach(() => {
  (globalThis as Record<string, unknown>).chrome = chromeMock;
});

describe('enableDeveloperMode', () => {
  it('turns Developer mode on through chrome://extensions, then closes the browser', async () => {
    const setting = developerModeSetting();
    const { launcher, steps } = fakeLauncher(setting.api);
    await enableDeveloperMode(launcher, { userDataDir: PROFILE });
    expect(setting.on).toBe(true);
    expect(steps).toEqual(['launch', 'goto chrome://extensions/', 'evaluate', 'close']);
  });

  it('starts the browser on the smoke profile, headless and without the extension', async () => {
    const { launcher, launch } = fakeLauncher(developerModeSetting().api);
    await enableDeveloperMode(launcher, { userDataDir: PROFILE });
    const options = launch.mock.calls[0][0];
    expect(options).toMatchObject({ headless: true, userDataDir: PROFILE });
    expect(options).not.toHaveProperty('enableExtensions');
    expect(options).not.toHaveProperty('executablePath');
  });

  it('starts the browser the caller names', async () => {
    const { launcher, launch } = fakeLauncher(developerModeSetting().api);
    const executablePath = join(sep, 'opt', 'chrome', 'chrome');
    await enableDeveloperMode(launcher, { userDataDir: PROFILE, executablePath });
    expect(launch.mock.calls[0][0]).toMatchObject({ userDataDir: PROFILE, executablePath });
  });

  it('rejects when Developer mode still reads off, and closes the browser', async () => {
    const setting = developerModeSetting();
    setting.api.updateProfileConfiguration = async () => {};
    const { launcher, steps } = fakeLauncher(setting.api);
    await expect(enableDeveloperMode(launcher, { userDataDir: PROFILE })).rejects.toThrow(
      'could not turn on Developer mode in the smoke profile: chrome://extensions still reports it off',
    );
    expect(steps.at(-1)).toBe('close');
  });

  it('rejects with the reason when the page cannot make the call, and closes the browser', async () => {
    const setting = developerModeSetting();
    setting.api.updateProfileConfiguration = async () => { throw new Error('no such method'); };
    const { launcher, steps } = fakeLauncher(setting.api);
    await expect(enableDeveloperMode(launcher, { userDataDir: PROFILE })).rejects.toThrow(
      'could not turn on Developer mode in the smoke profile: no such method',
    );
    expect(steps.at(-1)).toBe('close');
  });
});

describe('live smokes that reload the extension', () => {
  const scriptsDir = new URL('../../scripts/', import.meta.url);
  const reloading = readdirSync(scriptsDir)
    .filter((name) => name.endsWith('.mjs'))
    .map((name) => ({ name, src: readFileSync(new URL(name, scriptsDir), 'utf-8') }))
    .filter(({ src }) => /enableExtensions:\s*\[/.test(src) && src.includes('chrome.runtime.reload()'));

  it('are the download smokes and the notices smoke', () => {
    expect(reloading.map(({ name }) => name).sort()).toEqual([
      'smoke-devtools-downloads.mjs',
      'smoke-downloads.mjs',
      'smoke-notices.mjs',
    ]);
  });

  it.each(['smoke-devtools-downloads.mjs', 'smoke-downloads.mjs', 'smoke-notices.mjs'])(
    '%s turns Developer mode on in its profile before it starts its browser',
    (name) => {
      // Positions, not the source text, so a failure names the script and not its 300 lines.
      const src = readFileSync(new URL(name, scriptsDir), 'utf-8');
      const imported = src.indexOf("import { enableDeveloperMode } from './smoke-profile.mjs';");
      const profileLaunched = src.search(/^\s*userDataDir: profile,$/m);
      const prepared = src.indexOf(
        'await enableDeveloperMode(puppeteer, { userDataDir: profile, executablePath: process.env.CHROME_PATH });',
      );
      const launched = src.indexOf('await puppeteer.launch(launchOptions)');
      expect(imported, `${name} does not import enableDeveloperMode`).toBeGreaterThan(-1);
      expect(profileLaunched, `${name} does not launch its browser on \`profile\``).toBeGreaterThan(-1);
      expect(prepared, `${name} does not turn Developer mode on in \`profile\``).toBeGreaterThan(-1);
      expect(launched, `${name} does not launch with launchOptions`).toBeGreaterThan(-1);
      expect(prepared, `${name} turns Developer mode on after it starts its browser`).toBeLessThan(launched);
    },
  );
});
