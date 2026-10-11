/**
 * Developer mode for the browser profile a live smoke runs in.
 *
 * Chrome keeps an unpacked extension enabled only in a profile with Developer
 * mode on. Loading one over the debugging pipe (Puppeteer's enableExtensions)
 * is not held to that, but a reload is: on Chrome 154, chrome.runtime.reload()
 * in a profile with Developer mode off leaves the extension disabled
 * (chrome://extensions lists it with unsupportedDeveloperExtension), its
 * worker never starts again, and a smoke that waits for the worker stops with
 * "Timed out after waiting 20000ms". Chrome 145 reloaded it either way.
 *
 * Chrome signs the setting: a value written into the profile's Preferences
 * file is reset at startup. So the browser sets it. It is started once on the
 * profile, headless and without the extension, chrome://extensions turns
 * Developer mode on with the call its own toggle makes, and the browser is
 * closed. The smoke then starts its browser on that profile, so the harness
 * attaches to no page of the browser the smoke measures.
 */

/**
 * Turn Developer mode on in the profile at `userDataDir`.
 *
 * Call it after the profile directory exists and before the smoke launches
 * its own browser on it. Rejects when Developer mode could not be turned on;
 * the browser it started is closed either way.
 *
 * @param {{ launch: (options: object) => Promise<any> }} launcher Puppeteer
 * @param {{ userDataDir: string, executablePath?: string }} profile
 *   `executablePath` selects the browser, as CHROME_PATH does for the smoke;
 *   without it Puppeteer starts the one it installed.
 * @returns {Promise<void>}
 */
export async function enableDeveloperMode(launcher, { userDataDir, executablePath }) {
  const options = {
    headless: true,
    userDataDir,
    args: ['--no-first-run', '--no-default-browser-check'],
  };
  if (executablePath) options.executablePath = executablePath;
  const browser = await launcher.launch(options);
  try {
    const page = await browser.newPage();
    await page.goto('chrome://extensions/');
    const on = await page.evaluate(async () => {
      await chrome.developerPrivate.updateProfileConfiguration({ inDeveloperMode: true });
      return (await chrome.developerPrivate.getProfileConfiguration()).inDeveloperMode;
    });
    if (on !== true) throw new Error('chrome://extensions still reports it off');
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(`could not turn on Developer mode in the smoke profile: ${reason}`);
  } finally {
    await browser.close().catch(() => {});
  }
}
