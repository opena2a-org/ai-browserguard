/**
 * The extension's service worker, for the live smokes that load dist/ with
 * --load-extension.
 *
 * Chrome for Testing, the browser Puppeteer installs, loads the directory that
 * --load-extension names. Google Chrome 155 ignores the flag and starts with
 * no extension, so no worker appears and a smoke waiting for one has nothing
 * to check. waitForExtensionWorker waits as browser.waitForTarget does. When
 * no worker appears, it prints which browser ran, why there is no worker and
 * what to run instead, closes the browser and ends the process with exit code
 * 1, before the smoke's later checks.
 *
 * It says the browser ignored the flag only when chrome://extensions lists no
 * extension from the directory and the directory holds a manifest.json: a
 * directory without one (dist/ not built) leaves the list empty too.
 */
import { existsSync, realpathSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const FLAG = '--load-extension=';

/**
 * Wait for the extension's service worker in a browser launched with
 * --load-extension.
 *
 * @param {object} browser a Puppeteer Browser that this process launched
 * @param {(target: any) => boolean | Promise<boolean>} isWorker the predicate
 *   for browser.waitForTarget
 * @param {{ timeout: number }} options milliseconds to wait, as for
 *   browser.waitForTarget
 * @returns {Promise<any>} the worker's target. When none appears within
 *   `timeout`, it does not return: the explanation is printed, the browser is
 *   closed and the process exits with code 1. Any other error from
 *   browser.waitForTarget rejects as before.
 */
export async function waitForExtensionWorker(browser, isWorker, { timeout }) {
  // Throws for a browser started without --load-extension, whose missing
  // worker this module would explain wrongly.
  extensionDirs(browser);
  try {
    return await browser.waitForTarget(isWorker, { timeout });
  } catch (err) {
    if (err?.name !== 'TimeoutError') throw err;
  }
  console.error(await explainMissingWorker(browser, { timeout }));
  await browser.close().catch(() => {});
  process.exit(1);
}

/**
 * Why the extension's service worker did not appear, and what to run instead.
 *
 * @param {object} browser a Puppeteer Browser that this process launched with
 *   --load-extension
 * @param {{ timeout: number }} options the wait that ran out, in milliseconds
 * @returns {Promise<string>}
 */
export async function explainMissingWorker(browser, { timeout }) {
  const dirs = extensionDirs(browser);
  const executable = browser.process().spawnfile;
  const version = await browser.version().catch(() => 'unknown version');
  const seconds = timeout / 1000;
  const rerun = rerunCommand();
  const ran = [`  Browser:     ${version}`, `  Executable:  ${executable}`];

  const unbuilt = dirs.find((dir) => !existsSync(join(dir, 'manifest.json')));
  if (unbuilt) {
    return [
      'The extension did not load, so this smoke stops here.',
      ...ran,
      `  ${unbuilt}, the directory passed with --load-extension, has no manifest.json.`,
      '',
      'Build the extension, then run the smoke again:',
      '  npm run build',
      `  ${rerun}`,
    ].join('\n');
  }

  const remedies = [
    '  1. Chrome for Testing, the browser Puppeteer installs, loads it:',
    '       unset PUPPETEER_EXECUTABLE_PATH',
    `       ${rerun}`,
    '     If ~/.cache/puppeteer/chrome/ is empty, install it first:',
    '       npx puppeteer browsers install chrome',
    '  2. npm run smoke:downloads and npm run smoke:devtools load the extension over the',
    '     debugging pipe and run on the browser CHROME_PATH names. They check downloads,',
    "     not this smoke's checks:",
    `       CHROME_PATH=${shellWord(executable)} npm run smoke:downloads`,
    `       CHROME_PATH=${shellWord(executable)} npm run smoke:devtools`,
  ];

  let extensions;
  try {
    extensions = await listExtensions(browser);
  } catch (err) {
    return [
      'No service worker of the extension appeared, so this smoke stops here.',
      ...ran,
      `  None appeared within ${seconds} s, and chrome://extensions could not be read to tell why:`,
      `  ${err instanceof Error ? err.message : String(err)}`,
      '',
      'If this browser does not load an extension from --load-extension, use either:',
      ...remedies,
    ].join('\n');
  }

  const loaded = extensions
    .filter((ext) => ext.path)
    .map((ext) => ({ ext, dir: dirs.find((dir) => realPath(dir) === realPath(ext.path)) }))
    .find(({ dir }) => dir);
  if (loaded) {
    const { ext, dir } = loaded;
    return [
      'The extension loaded, but the service worker this smoke waits for did not appear,',
      'so the smoke stops here.',
      ...ran,
      `  chrome://extensions lists the extension loaded from ${dir}, state ${ext.state}.`,
      `  The service worker this smoke waits for did not appear within ${seconds} s.`,
      ...(ext.errors.length > 0
        ? ext.errors.map((message) => `  Error: ${message}`)
        : ['  chrome://extensions lists no error for the extension.']),
      '',
      'Rebuild the extension and run the smoke again:',
      '  npm run build',
      `  ${rerun}`,
      'If it stops here again, load the directory above with Load unpacked on',
      'chrome://extensions and read the errors listed for its service worker.',
    ].join('\n');
  }

  return [
    'The extension did not load, so this smoke stops here.',
    ...ran,
    '  This browser ignored --load-extension: no service worker of the extension appeared',
    `  within ${seconds} s, and chrome://extensions lists no extension loaded from`,
    `  ${dirs.join(', ')}.`,
    '',
    'Run the smoke on a browser that loads --load-extension, or check this browser with',
    'the smokes that load the extension another way:',
    ...remedies,
  ].join('\n');
}

/** The directories the browser was told to load with --load-extension. */
function extensionDirs(browser) {
  const arg = browser.process()?.spawnargs.find((a) => a.startsWith(FLAG));
  if (!arg) throw new Error('waitForExtensionWorker needs a browser started with --load-extension');
  return arg.slice(FLAG.length).split(',');
}

/** Every extension chrome://extensions lists, with its path, state and errors. */
async function listExtensions(browser) {
  const page = await browser.newPage();
  try {
    await page.goto('chrome://extensions/', { timeout: 10_000 });
    return await page.evaluate(async () => {
      const all = await chrome.developerPrivate.getExtensionsInfo({ includeDisabled: true, includeTerminated: true });
      return all.map((ext) => ({
        path: ext.path ?? null,
        state: ext.state,
        errors: [...ext.manifestErrors, ...ext.runtimeErrors].map((error) => error.message),
      }));
    });
  } finally {
    await page.close().catch(() => {});
  }
}

/**
 * `path` with symbolic links resolved, as Chrome lists an extension's path and
 * as process.cwd() reports the working directory (/private/tmp for /tmp on
 * macOS).
 */
function realPath(path) {
  try { return realpathSync(path); } catch { return resolve(path); }
}

/** The command that runs this smoke again. */
function rerunCommand() {
  const script = process.env.npm_lifecycle_event;
  if (script) return `npm run ${script}`;
  return `node ${shellWord(relative(process.cwd(), realPath(process.argv[1])))}`;
}

/** `value` as one POSIX shell word. */
function shellWord(value) {
  return /^[\w@%+=:,./-]+$/.test(value) ? value : `'${value.replaceAll("'", `'\\''`)}'`;
}
