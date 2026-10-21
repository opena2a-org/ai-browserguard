/**
 * The worker wait of the live smokes that load dist/ with --load-extension.
 *
 * Google Chrome 155 ignores --load-extension and starts with no extension.
 * With PUPPETEER_EXECUTABLE_PATH set to it, `npm run smoke:load` printed
 * "FAIL  service worker registers" and went on to its next check, and
 * `npm run smoke:scenarios` stopped with "Timed out after waiting 10000ms";
 * neither said which browser ran, why no worker appeared or what to run
 * instead. These cases pin scripts/smoke-launch.mjs, which says all three
 * and ends the run with exit code 1, and that every Puppeteer smoke that
 * passes --load-extension waits for the worker through it.
 *
 * Chrome for Testing refuses a dist/ whose manifest.json names a missing
 * service worker, and then lists no extension from it, as a browser that
 * ignores the flag does; the explanation said it ignored --load-extension.
 * These cases also pin that it names one of the two causes only when the
 * browser's own log, chrome_debug.log in its profile, records it, and both
 * causes otherwise.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { waitForExtensionWorker, explainMissingWorker } from '../../scripts/smoke-launch.mjs';

const GOOGLE_CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const CHROME_FOR_TESTING =
  '/Users/dev/.cache/puppeteer/chrome/mac_arm-145.0.7632.77/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';

/** chrome_debug.log of Google Chrome 155, started as the smokes start it. */
const GOOGLE_CHROME_LOG = [
  '[28805:158876359:1020/185917.503322:INFO:components/enterprise/browser/controller/chrome_browser_cloud_management_controller.cc:241] No machine level policy manager exists.',
  '[28805:158876359:1020/185917.534898:WARNING:chrome/browser/extensions/extension_service.cc:445] --disable-extensions-except is not allowed in Google Chrome, ignoring.',
  '',
].join('\n');

/** The line Chrome for Testing 145 logs when it refuses the extension in `dir`. */
const refusedLine = (dir: string) =>
  `[48117:159123882:1020/190153.609094:WARNING:extensions/browser/load_error_reporter.cc:73] Extension error: Failed to load extension from: ${dir}. Could not load background script ''.`;

interface FakeTarget {
  type: () => string;
  url: () => string;
}

/** An extension as chrome.developerPrivate.getExtensionsInfo() describes it. */
interface ListedExtension {
  path: string | null;
  state: string;
  manifestErrors: { message: string }[];
  runtimeErrors: { message: string }[];
}

const isWorker = (t: FakeTarget) => t.type() === 'service_worker' && t.url().includes('background/index.js');
const WORKER: FakeTarget = {
  type: () => 'service_worker',
  url: () => 'chrome-extension://abcdefghijklmnopabcdefghijklmnop/background/index.js',
};

const created: string[] = [];

/** An extension directory, built (with its manifest.json) unless `built` is false. */
function extensionDir(built = true): string {
  const dir = mkdtempSync(join(tmpdir(), 'abg-smoke-launch-'));
  created.push(dir);
  if (built) writeFileSync(join(dir, 'manifest.json'), '{"manifest_version": 3}');
  return dir;
}

/**
 * A browser Puppeteer started on Google Chrome, or on `executable` reporting
 * `version`, with --load-extension=<dir> and, unless `logging` is false,
 * --enable-logging. Its profile holds `log` as chrome_debug.log.
 * Its waitForTarget yields `worker`, rejects with `waitError`, or rejects as
 * Puppeteer's does once `timeout` passes with no matching target.
 * chrome://extensions lists `listed`, or reading the list throws `listError`.
 */
function fakeBrowser(
  dir: string | null,
  opts: {
    worker?: FakeTarget; waitError?: Error; listed?: ListedExtension[]; listError?: Error;
    executable?: string; version?: string; log?: string; logging?: boolean;
  } = {},
) {
  const steps: string[] = [];
  const page = {
    goto: async (url: string) => { steps.push(`goto ${url}`); },
    evaluate: async (fn: () => unknown) => {
      if (opts.listError) throw opts.listError;
      (globalThis as Record<string, unknown>).chrome = {
        developerPrivate: { getExtensionsInfo: async () => opts.listed ?? [] },
      };
      return fn();
    },
    close: async () => { steps.push('close page'); },
  };
  const executable = opts.executable ?? GOOGLE_CHROME;
  const profile = mkdtempSync(join(tmpdir(), 'abg-smoke-profile-'));
  created.push(profile);
  if (opts.log !== undefined) writeFileSync(join(profile, 'chrome_debug.log'), opts.log);
  const spawnargs = [executable, '--no-sandbox', `--user-data-dir=${profile}`];
  if (dir) spawnargs.push(`--disable-extensions-except=${dir}`, `--load-extension=${dir}`);
  if (opts.logging ?? true) spawnargs.push('--enable-logging');
  const browser = {
    waitForTarget: vi.fn(
      (_predicate: (t: FakeTarget) => boolean, { timeout }: { timeout: number }) =>
        new Promise((resolve, reject) => {
          if (opts.worker) resolve(opts.worker);
          else if (opts.waitError) reject(opts.waitError);
          else {
            const timedOut = Object.assign(new Error(`Timed out after waiting ${timeout}ms`), { name: 'TimeoutError' });
            setTimeout(() => reject(timedOut), timeout);
          }
        }),
    ),
    version: async () => opts.version ?? 'Chrome/155.0.8059.84',
    process: () => ({ spawnfile: executable, spawnargs }),
    newPage: async () => page,
    close: vi.fn(async () => { steps.push('close browser'); }),
  };
  return { browser, steps };
}

/** process.exit and console.error, recorded in `steps` instead of run. */
function spyOnExit(steps: string[]) {
  const exit = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    steps.push(`exit ${code}`);
  }) as never);
  const error = vi.spyOn(console, 'error').mockImplementation(() => { steps.push('print'); });
  return { exit, error };
}

const chromeMock = (globalThis as Record<string, unknown>).chrome;
beforeEach(() => {
  vi.stubEnv('npm_lifecycle_event', 'smoke:load');
});
afterEach(() => {
  (globalThis as Record<string, unknown>).chrome = chromeMock;
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('waitForExtensionWorker', () => {
  it('resolves to the worker as browser.waitForTarget does and prints nothing when it appears', async () => {
    const { browser, steps } = fakeBrowser(extensionDir(), { worker: WORKER });
    const { exit, error } = spyOnExit(steps);
    await expect(waitForExtensionWorker(browser, isWorker, { timeout: 10000 })).resolves.toBe(WORKER);
    expect(browser.waitForTarget).toHaveBeenCalledWith(isWorker, { timeout: 10000 });
    expect(error).not.toHaveBeenCalled();
    expect(exit).not.toHaveBeenCalled();
    expect(browser.close).not.toHaveBeenCalled();
  });

  it('when no worker appears, prints one explanation that names the browser and both remedies, then closes the browser and exits 1', async () => {
    const { browser, steps } = fakeBrowser(extensionDir(), { log: GOOGLE_CHROME_LOG });
    const { exit, error } = spyOnExit(steps);
    await waitForExtensionWorker(browser, isWorker, { timeout: 5 });

    expect(error).toHaveBeenCalledTimes(1);
    const text = String(error.mock.calls[0][0]);
    expect(text).toContain('Chrome/155.0.8059.84');
    expect(text).toContain(GOOGLE_CHROME);
    expect(text).toContain('This browser ignored --load-extension');
    // Chrome for Testing, which Puppeteer installs.
    expect(text).toContain('unset PUPPETEER_EXECUTABLE_PATH\n');
    expect(text).toContain('npm run smoke:load\n');
    expect(text).toContain('npx puppeteer browsers install chrome');
    // The smokes that load the extension over the debugging pipe, on this browser.
    expect(text).toContain(`CHROME_PATH='${GOOGLE_CHROME}' npm run smoke:downloads`);
    expect(text).toContain(`CHROME_PATH='${GOOGLE_CHROME}' npm run smoke:devtools`);
    expect(text).not.toContain('!');

    expect(exit).toHaveBeenCalledWith(1);
    expect(steps).toEqual(['goto chrome://extensions/', 'close page', 'print', 'close browser', 'exit 1']);
  });

  it('passes on an error other than the timeout, without printing or exiting', async () => {
    const { browser, steps } = fakeBrowser(extensionDir(), { waitError: new Error('Protocol error: Connection closed.') });
    const { exit, error } = spyOnExit(steps);
    await expect(waitForExtensionWorker(browser, isWorker, { timeout: 5 })).rejects.toThrow('Connection closed');
    expect(error).not.toHaveBeenCalled();
    expect(exit).not.toHaveBeenCalled();
  });

  it('rejects a browser started without --load-extension, whose missing worker it cannot explain', async () => {
    const { browser, steps } = fakeBrowser(null, { worker: WORKER });
    const { exit } = spyOnExit(steps);
    await expect(waitForExtensionWorker(browser, isWorker, { timeout: 5 })).rejects.toThrow(
      'waitForExtensionWorker needs a browser started with --load-extension',
    );
    expect(browser.waitForTarget).not.toHaveBeenCalled();
    expect(exit).not.toHaveBeenCalled();
  });
});

describe('explainMissingWorker', () => {
  it('gives the command of the smoke that ran', async () => {
    vi.stubEnv('npm_lifecycle_event', 'smoke:scope');
    const { browser } = fakeBrowser(extensionDir());
    const text = await explainMissingWorker(browser, { timeout: 10000 });
    expect(text).toContain('unset PUPPETEER_EXECUTABLE_PATH\n       npm run smoke:scope\n');
    expect(text).toContain('within 10 s');
  });

  it('gives the node command of the script when npm did not start it', async () => {
    vi.stubEnv('npm_lifecycle_event', undefined);
    const argv1 = process.argv[1];
    process.argv[1] = join(process.cwd(), 'scripts', 'smoke-load.mjs');
    try {
      const { browser } = fakeBrowser(extensionDir());
      const text = await explainMissingWorker(browser, { timeout: 10000 });
      expect(text).toContain(`unset PUPPETEER_EXECUTABLE_PATH\n       node ${join('scripts', 'smoke-load.mjs')}\n`);
    } finally {
      process.argv[1] = argv1;
    }
  });

  it('says the browser ignored --load-extension when it logged so and lists only extensions from elsewhere', async () => {
    const other = extensionDir();
    const { browser } = fakeBrowser(extensionDir(), {
      listed: [
        { path: null, state: 'ENABLED', manifestErrors: [], runtimeErrors: [] },
        { path: other, state: 'ENABLED', manifestErrors: [], runtimeErrors: [] },
      ],
      log: GOOGLE_CHROME_LOG,
    });
    const text = await explainMissingWorker(browser, { timeout: 10000 });
    expect(text).toContain('This browser ignored --load-extension');
    expect(text).toContain(
      'and the browser logged:\n    --disable-extensions-except is not allowed in Google Chrome, ignoring.\n',
    );
    expect(text).not.toContain('Either this browser');
  });

  it('takes the --load-extension line Google Chrome logs as the same evidence', async () => {
    const line = '--load-extension is not allowed in Google Chrome, ignoring.';
    const { browser } = fakeBrowser(extensionDir(), {
      log: `[74759:159592710:1020/190657.071908:WARNING:chrome/browser/extensions/extension_service.cc:423] ${line}\n`,
    });
    const text = await explainMissingWorker(browser, { timeout: 10000 });
    expect(text).toContain('This browser ignored --load-extension');
    expect(text).toContain(`and the browser logged:\n    ${line}\n`);
  });

  it('does not say the browser ignored --load-extension when nothing it logged says so, and names both causes', async () => {
    // Chrome for Testing refuses a dist/ whose manifest.json names a missing
    // service worker. Without its log, the explanation cannot tell that from
    // a browser that ignores the flag.
    const dir = extensionDir();
    const { browser } = fakeBrowser(dir, {
      executable: CHROME_FOR_TESTING,
      version: 'Chrome/145.0.7632.77',
      log: '[1188:158811694:1020/185838.562063:ERROR:google_apis/gcm/engine/registration_request.cc:290] Registration response error message: PHONE_REGISTRATION_ERROR\n',
    });
    const text = await explainMissingWorker(browser, { timeout: 10000 });
    expect(text).toContain('Chrome/145.0.7632.77');
    expect(text).not.toContain('This browser ignored --load-extension');
    expect(text).toContain('Either this browser ignored --load-extension, or it refused the extension');
    expect(text).toContain(`To check the manifest, load ${dir} with Load unpacked on chrome://extensions.`);
    expect(text).toContain('npm run build\n  npm run smoke:load\n');
    expect(text).toContain('If it loads there, this browser ignored --load-extension. Use either:');
    expect(text).toContain('unset PUPPETEER_EXECUTABLE_PATH');
  });

  it('says the browser refused the extension and gives the error it logged', async () => {
    const dir = extensionDir();
    const { browser } = fakeBrowser(dir, {
      executable: CHROME_FOR_TESTING,
      version: 'Chrome/145.0.7632.77',
      // Chrome for Testing logs the resolved path (/private/tmp/... for
      // /tmp/... on macOS). The line twice: the error is printed once.
      log: `${refusedLine(realpathSync(dir))}\n${refusedLine(realpathSync(dir))}\n`,
    });
    const text = await explainMissingWorker(browser, { timeout: 10000 });
    expect(text).not.toContain('ignored --load-extension');
    expect(text).toContain(`This browser refused the extension in ${dir}. It logged:\n    Could not load background script ''.\n\n`);
    expect(text).toContain('npm run build\n  npm run smoke:load\n');
    expect(text).toContain('load the directory above with Load unpacked');
    expect(text).not.toContain('unset PUPPETEER_EXECUTABLE_PATH');
  });

  it('does not take an error logged for another directory as the cause', async () => {
    const dir = extensionDir();
    const { browser } = fakeBrowser(dir, { log: `${refusedLine(`${realpathSync(dir)}-copy`)}\n` });
    const text = await explainMissingWorker(browser, { timeout: 10000 });
    expect(text).not.toContain('refused the extension in');
    expect(text).toContain('Either this browser ignored --load-extension, or it refused the extension');
  });

  it('reads no log from a browser started without --enable-logging, whose profile may hold an earlier one', async () => {
    const { browser } = fakeBrowser(extensionDir(), { log: GOOGLE_CHROME_LOG, logging: false });
    const text = await explainMissingWorker(browser, { timeout: 10000 });
    expect(text).not.toContain('This browser ignored --load-extension');
    expect(text).toContain('Either this browser ignored --load-extension, or it refused the extension');
  });

  it('does not say the browser ignored --load-extension when it lists the extension, and gives its errors', async () => {
    const dir = extensionDir();
    const { browser } = fakeBrowser(dir, {
      listed: [{
        // Chrome reports the resolved path (/private/var/... for /var/... on macOS).
        path: realpathSync(dir),
        state: 'ENABLED',
        manifestErrors: [],
        runtimeErrors: [{ message: 'Service worker registration failed. Status code: 3' }],
      }],
    });
    const text = await explainMissingWorker(browser, { timeout: 10000 });
    expect(text).not.toContain('ignored --load-extension');
    expect(text).toContain(`lists the extension loaded from ${dir}, state ENABLED.`);
    expect(text).toContain('Error: Service worker registration failed. Status code: 3');
    expect(text).toContain('npm run build\n  npm run smoke:load\n');
  });

  it('says to build first when the directory has no manifest.json', async () => {
    const dir = extensionDir(false);
    const { browser, steps } = fakeBrowser(dir);
    const text = await explainMissingWorker(browser, { timeout: 10000 });
    expect(text).toContain(`${dir}, the directory passed with --load-extension, has no manifest.json`);
    expect(text).toContain('npm run build\n  npm run smoke:load');
    expect(text).not.toContain('ignored --load-extension');
    expect(steps).toEqual([]);
  });

  it('names no cause when the extension list cannot be read, and gives both remedies', async () => {
    const { browser } = fakeBrowser(extensionDir(), { listError: new Error('net::ERR_BLOCKED_BY_ADMINISTRATOR') });
    const text = await explainMissingWorker(browser, { timeout: 10000 });
    expect(text).not.toContain('ignored --load-extension');
    expect(text).toContain('net::ERR_BLOCKED_BY_ADMINISTRATOR');
    expect(text).toContain('unset PUPPETEER_EXECUTABLE_PATH');
    expect(text).toContain(`CHROME_PATH='${GOOGLE_CHROME}' npm run smoke:downloads`);
  });
});

describe('Puppeteer smokes that load the extension with --load-extension', () => {
  const scriptsDir = new URL('../../scripts/', import.meta.url);
  const smokes = readdirSync(scriptsDir)
    .filter((name) => /^smoke-.*\.mjs$/.test(name))
    .map((name) => ({ name, src: readFileSync(new URL(name, scriptsDir), 'utf-8') }))
    .filter(({ src }) => src.includes('--load-extension') && /from ['"]puppeteer['"]|import\(\s*['"]puppeteer['"]\s*\)/.test(src));

  it('include the five that wait for its worker', () => {
    expect(smokes.map(({ name }) => name)).toEqual(expect.arrayContaining([
      'smoke-arming.mjs',
      'smoke-cdp-enforcement.mjs',
      'smoke-load.mjs',
      'smoke-scenarios.mjs',
      'smoke-scope.mjs',
    ]));
  });

  it.each(smokes.map(({ name }) => name))('%s waits for the worker through scripts/smoke-launch.mjs', (name) => {
    // Booleans, not the source text, so a failure names the script and not its 600 lines.
    const { src } = smokes.find((smoke) => smoke.name === name)!;
    const imported = /^import \{ waitForExtensionWorker \} from '\.\/smoke-launch\.mjs';$/m.test(src);
    const waits = /await waitForExtensionWorker\(\s*browser,/.test(src);
    expect(imported, `${name} does not import waitForExtensionWorker from ./smoke-launch.mjs`).toBe(true);
    expect(waits, `${name} does not wait for the worker with waitForExtensionWorker`).toBe(true);
  });

  it.each(smokes.map(({ name }) => name))('%s starts the browser with --enable-logging, whose log the worker wait reads', (name) => {
    const { src } = smokes.find((smoke) => smoke.name === name)!;
    expect(src.includes(`'--enable-logging'`), `${name} does not pass --enable-logging`).toBe(true);
  });
});
