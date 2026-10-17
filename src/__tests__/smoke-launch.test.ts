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
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { waitForExtensionWorker, explainMissingWorker } from '../../scripts/smoke-launch.mjs';

const GOOGLE_CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

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
 * A browser Puppeteer started on Google Chrome with --load-extension=<dir>.
 * Its waitForTarget yields `worker`, rejects with `waitError`, or rejects as
 * Puppeteer's does once `timeout` passes with no matching target.
 * chrome://extensions lists `listed`, or reading the list throws `listError`.
 */
function fakeBrowser(
  dir: string | null,
  opts: { worker?: FakeTarget; waitError?: Error; listed?: ListedExtension[]; listError?: Error } = {},
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
  const spawnargs = [GOOGLE_CHROME, '--no-sandbox'];
  if (dir) spawnargs.push(`--disable-extensions-except=${dir}`, `--load-extension=${dir}`);
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
    version: async () => 'Chrome/155.0.8059.84',
    process: () => ({ spawnfile: GOOGLE_CHROME, spawnargs }),
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
    const { browser, steps } = fakeBrowser(extensionDir());
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

  it('says the browser ignored --load-extension when it lists only extensions from elsewhere', async () => {
    const other = extensionDir();
    const { browser } = fakeBrowser(extensionDir(), {
      listed: [
        { path: null, state: 'ENABLED', manifestErrors: [], runtimeErrors: [] },
        { path: other, state: 'ENABLED', manifestErrors: [], runtimeErrors: [] },
      ],
    });
    const text = await explainMissingWorker(browser, { timeout: 10000 });
    expect(text).toContain('This browser ignored --load-extension');
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
});
