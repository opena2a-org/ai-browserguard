/**
 * scripts/generate-screenshots.mjs stops with one line naming `npm run build`
 * when dist/ has not been built (#165).
 *
 * The script captures the built popup, dist/popup/index.html, from a local
 * server. Run before `npm run build`, it launched the browser, the server
 * answered 404 for the popup page, and the first capture's setup function ran
 * against that page: the script stopped with "TypeError: Cannot set
 * properties of null (setting 'className')" and a stack trace.
 *
 * Each case runs a copy of the script, of the four scripts it imports and of
 * manifest.json, which it reads, in a temporary directory laid out like the
 * repository whose node_modules/puppeteer is a stand-in. The stand-in browser
 * prints a line when it is launched and keeps the process running until it is
 * closed. Its page requests its address from the script's server and prints
 * the status of the answer. When the status is 200, getElementById finds an
 * element for each id; on the 404 page it finds nothing, as it does in
 * Chrome. The time zone and locale the script sets for the page are accepted
 * and not applied. Each screenshot writes a file.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const REPO = fileURLToPath(new URL('../../', import.meta.url));
// How long a copy may run before it counts as still running and is stopped.
const WAIT_MS = 10_000;
const COPIED = [
  'scripts/generate-screenshots.mjs',
  'scripts/screenshot-checksums.mjs',
  'scripts/screenshot-panels.mjs',
  'scripts/screenshot-popup-parts.mjs',
  'scripts/screenshot-timeline.mjs',
  'manifest.json',
];
const LAUNCHED = 'stand-in browser launched';
const LOADED = 'stand-in page loaded with status';
const NOT_BUILT = 'dist/popup/index.html not found. Run `npm run build` first.\n';
const CAPTURES = ['1-detection.png', '2-delegation.png', '3-readOnly.png', '4-killswitch.png'];

const STAND_IN = `
import { writeFileSync } from 'fs';

// An element of the popup page: it takes any property and any call. It has
// no then, so an evaluate that returns one resolves to it.
function element() {
  return new Proxy(function () {}, {
    get: (_, key) => (key === 'then' ? undefined : element()),
    set: () => true,
    apply: () => element(),
  });
}

export async function launch() {
  console.log('${LAUNCHED}');
  const open = setInterval(() => {}, 1000);
  return {
    async newPage() {
      let status = 0;
      return {
        async setViewport() {},
        async emulateTimezone() {},
        async createCDPSession() {
          return { async send() {} };
        },
        async goto(url) {
          const response = await fetch(url);
          await response.arrayBuffer();
          status = response.status;
          console.log('${LOADED} ' + status);
        },
        async addStyleTag() {},
        async evaluate(fn, arg) {
          globalThis.document = {
            fonts: { ready: Promise.resolve() },
            getElementById: () => (status === 200 ? element() : null),
            createElement: () => element(),
          };
          return fn(arg);
        },
        async screenshot({ path }) {
          writeFileSync(path, 'stand-in capture');
        },
        async close() {},
      };
    },
    async close() {
      clearInterval(open);
    },
  };
}

export default { launch };
`;

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/**
 * Run a copy of generate-screenshots.mjs with the stand-in browser, in a copy
 * of the repository whose dist/ holds the files in `dist` (no dist/ when it is
 * null), and stop it when it has not exited after WAIT_MS. `dir` is the copy's
 * docs/screenshots directory, where the captures are saved.
 */
function generate(dist: Record<string, string> | null) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'generate-screenshots-')));
  dirs.push(root);
  for (const file of COPIED) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    copyFileSync(join(REPO, file), join(root, file));
  }
  for (const [file, text] of Object.entries(dist ?? {})) {
    mkdirSync(dirname(join(root, 'dist', file)), { recursive: true });
    writeFileSync(join(root, 'dist', file), text);
  }
  const dir = join(root, 'docs', 'screenshots');
  mkdirSync(dir, { recursive: true });
  const standIn = join(root, 'node_modules', 'puppeteer');
  mkdirSync(standIn, { recursive: true });
  writeFileSync(join(standIn, 'package.json'), '{"name": "puppeteer", "type": "module", "exports": "./index.js"}\n');
  writeFileSync(join(standIn, 'index.js'), STAND_IN);
  const run = spawnSync(process.execPath, [join(root, 'scripts', 'generate-screenshots.mjs')], {
    cwd: root,
    encoding: 'utf-8',
    timeout: WAIT_MS,
  });
  return { dir, status: run.status, signal: run.signal, stdout: run.stdout, stderr: run.stderr };
}

const NOT_BUILT_TREES: Array<[string, Record<string, string> | null]> = [
  ['there is no dist/ directory', null],
  ['dist/ holds no popup/index.html', { 'manifest.json': '{}\n' }],
];

describe('scripts/generate-screenshots.mjs', () => {
  it.each(NOT_BUILT_TREES)(
    'prints one line naming npm run build and exits 1, before it launches the browser, when %s (#165)',
    (_, dist) => {
      const run = generate(dist);
      expect(run.signal).toBeNull();
      expect(run.status).toBe(1);
      expect(run.stderr).toBe(NOT_BUILT);
      // The stand-in browser prints a line when it is launched.
      expect(run.stdout).toBe('');
      expect(readdirSync(run.dir)).toEqual([]);
    },
    WAIT_MS * 2,
  );

  it('launches the browser and saves the four popup captures when dist/popup/index.html exists', () => {
    const run = generate({ 'popup/index.html': '<!doctype html>\n<title>AI Browser Guard</title>\n' });
    expect(run.signal).toBeNull();
    expect(run.status).toBe(0);
    expect(run.stderr).toBe('');
    expect(run.stdout).toContain(LAUNCHED);
    expect(run.stdout.split('\n').filter((line) => line === `${LOADED} 200`)).toHaveLength(CAPTURES.length);
    expect(run.stdout).toContain('All screenshots generated.');
    expect(readdirSync(run.dir).sort()).toEqual([...CAPTURES, 'checksums.json'].sort());
  }, WAIT_MS * 2);
});
