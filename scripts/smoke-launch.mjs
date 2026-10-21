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
 * A directory without a manifest.json (dist/ not built) is the cause it names
 * first. Otherwise, when chrome://extensions lists no extension from the
 * directory, the browser either ignored the flag or refused the extension,
 * and it names one of the two only when the browser's own log records it.
 * Started with --enable-logging, Chrome for Testing 145 and Google Chrome 155
 * write that log to chrome_debug.log in their profile. Chrome for Testing
 * logs "Failed to load extension from: <directory>. <error>" for an extension
 * it refused, and Google Chrome logs "--disable-extensions-except is not
 * allowed in Google Chrome, ignoring." (or the same for --load-extension).
 * With neither line in the log, it names both causes.
 */
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const FLAG = '--load-extension=';
const PROFILE_FLAG = '--user-data-dir=';
/** What Google Chrome logs for an extension switch it ignores. */
const NOT_ALLOWED = /(--(?:load-extension|disable-extensions-except) is not allowed in .+, ignoring\.)\s*$/;

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

  const log = browserLog(browser);
  const refused = dirs
    .map((dir) => ({ dir, errors: loadErrors(log, dir) }))
    .find(({ errors }) => errors.length > 0);
  if (refused) {
    return [
      'The extension did not load, so this smoke stops here.',
      ...ran,
      `  This browser refused the extension in ${refused.dir}. It logged:`,
      ...refused.errors.map((error) => `    ${error}`),
      '',
      'Build the extension and run the smoke again:',
      '  npm run build',
      `  ${rerun}`,
      'If it stops here again, load the directory above with Load unpacked on',
      'chrome://extensions to check its manifest.',
    ].join('\n');
  }

  const ignored = [...new Set(log.map((line) => NOT_ALLOWED.exec(line)?.[1]).filter(Boolean))];
  if (ignored.length > 0) {
    return [
      'The extension did not load, so this smoke stops here.',
      ...ran,
      '  This browser ignored --load-extension: no service worker of the extension appeared',
      `  within ${seconds} s, chrome://extensions lists no extension loaded from`,
      `  ${dirs.join(', ')}, and the browser logged:`,
      ...ignored.map((line) => `    ${line}`),
      '',
      'Run the smoke on a browser that loads --load-extension, or check this browser with',
      'the smokes that load the extension another way:',
      ...remedies,
    ].join('\n');
  }

  return [
    'The extension did not load, so this smoke stops here.',
    ...ran,
    `  No service worker of the extension appeared within ${seconds} s, and chrome://extensions`,
    `  lists no extension loaded from ${dirs.join(', ')}.`,
    '  Either this browser ignored --load-extension, or it refused the extension, for',
    '  example because a file its manifest.json names is missing.',
    '',
    `To check the manifest, load ${dirs.join(', ')} with Load unpacked on chrome://extensions.`,
    'If the browser refuses it there, fix what it reports, then build and run the smoke again:',
    '  npm run build',
    `  ${rerun}`,
    'If it loads there, this browser ignored --load-extension. Use either:',
    ...remedies,
  ].join('\n');
}

/** The directories the browser was told to load with --load-extension. */
function extensionDirs(browser) {
  const arg = browser.process()?.spawnargs.find((a) => a.startsWith(FLAG));
  if (!arg) throw new Error('waitForExtensionWorker needs a browser started with --load-extension');
  return arg.slice(FLAG.length).split(',');
}

/**
 * The lines of chrome_debug.log in the browser's profile, which the browser
 * writes when started with --enable-logging. None when it was started without
 * that flag, whose profile may hold the log of an earlier launch.
 */
function browserLog(browser) {
  const args = browser.process()?.spawnargs ?? [];
  const profile = args.find((a) => a.startsWith(PROFILE_FLAG))?.slice(PROFILE_FLAG.length);
  if (!profile || !args.includes('--enable-logging')) return [];
  try {
    return readFileSync(join(profile, 'chrome_debug.log'), 'utf8').split('\n');
  } catch {
    return [];
  }
}

/**
 * The errors the browser logged for the extension in `dir`. Chrome for Testing
 * logs the directory with symbolic links resolved (/private/tmp for /tmp on
 * macOS), so both forms are matched.
 */
function loadErrors(log, dir) {
  const prefixes = [...new Set([dir, realPath(dir)])].map((path) => `Failed to load extension from: ${path}. `);
  const errors = log.flatMap((line) => {
    const prefix = prefixes.find((p) => line.includes(p));
    return prefix ? [line.slice(line.indexOf(prefix) + prefix.length).trim()] : [];
  });
  return [...new Set(errors)];
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
