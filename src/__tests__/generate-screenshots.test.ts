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
 * Chrome. The page's navigator reports the user agent of
 * chrome-headless-shell 145 whatever the version of Node: Node 20, which CI
 * runs, has no navigator, and later versions have one that names Node. The
 * user agent the script sets for the page is printed. The time zone and
 * locale the script sets for the page are accepted and not applied. Each
 * screenshot writes a file.
 *
 * The script's server serves the files under dist/ and answers 404 for a
 * request path that resolves outside it (#171). When a case names request
 * paths, the stand-in page sends each of them to the server unchanged, before
 * its first page load, and prints the status and body of the answer: fetch
 * would resolve the ".." segments of a path before sending it.
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
  'scripts/static-path.mjs',
  'manifest.json',
];
const LAUNCHED = 'stand-in browser launched';
const LOADED = 'stand-in page loaded with status';
const USER_AGENT_SET = 'stand-in page user agent set to';
const ANSWERED = 'stand-in request answered';
const POPUP_HTML = '<!doctype html>\n<title>AI Browser Guard</title>\n';
// The user agent chrome-headless-shell 145 reports, and the one the script
// sets for the page: the same version under the name Chrome uses.
const HEADLESS_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/145.0.7632.77 Safari/537.36';
const CHROME_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.7632.77 Safari/537.36';
const NOT_BUILT = 'dist/popup/index.html not found. Run `npm run build` first.\n';
const CAPTURES = ['1-detection.png', '2-delegation.png', '3-readOnly.png', '4-killswitch.png'];

const STAND_IN = `
import { writeFileSync } from 'fs';
import { request } from 'http';

// The request paths to send to the script's server before the first page
// load, as they are written: http.request does not resolve "..".
const REQUESTS = JSON.parse(process.env.STAND_IN_REQUESTS ?? '[]');
let requested = false;

function get(url, path) {
  return new Promise((resolve, reject) => {
    const { hostname, port } = new URL(url);
    request({ hostname, port, path }, (response) => {
      let body = '';
      response.setEncoding('utf-8');
      response.on('data', (chunk) => (body += chunk));
      response.on('end', () => resolve({ status: response.statusCode, body }));
    })
      .on('error', reject)
      .end();
  });
}

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
          return {
            async send(method, params) {
              if (method === 'Emulation.setUserAgentOverride') console.log('${USER_AGENT_SET} ' + params.userAgent);
            },
          };
        },
        async goto(url) {
          if (!requested) {
            requested = true;
            for (const path of REQUESTS) {
              const answer = await get(url, path);
              console.log('${ANSWERED} ' + JSON.stringify({ path, ...answer }));
            }
          }
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
          // Node 20 has no navigator, and the one of later versions names Node
          // and cannot be assigned to, so it is replaced.
          Object.defineProperty(globalThis, 'navigator', {
            value: { userAgent: '${HEADLESS_USER_AGENT}' },
            configurable: true,
            writable: true,
          });
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
 * null), and stop it when it has not exited after WAIT_MS. `outside` holds
 * files written relative to the copy's root, and `requests` the request paths
 * the stand-in page sends to the server. `dir` is the copy's docs/screenshots
 * directory, where the captures are saved.
 */
function generate(
  dist: Record<string, string> | null,
  { outside = {}, requests = [] }: { outside?: Record<string, string>; requests?: string[] } = {},
) {
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
  for (const [file, text] of Object.entries(outside)) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), text);
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
    env: { ...process.env, STAND_IN_REQUESTS: JSON.stringify(requests) },
  });
  return { dir, status: run.status, signal: run.signal, stdout: run.stdout, stderr: run.stderr };
}

/** The answers the stand-in page printed for its requests, in order. */
function answers(stdout: string) {
  return stdout
    .split('\n')
    .filter((line) => line.startsWith(`${ANSWERED} `))
    .map((line) => JSON.parse(line.slice(ANSWERED.length + 1)));
}

// Request paths that resolve outside dist/ of the copy: its package.json, a
// file beside dist/ whose name starts with "dist", and a file in a directory
// beside dist/ whose name does.
const OUTSIDE = {
  'package.json': '{"name": "outside-dist"}\n',
  'dist.zip': 'outside-dist archive\n',
  'dist-archive/notes.txt': 'outside-dist notes\n',
};
const OUTSIDE_REQUESTS = [
  '/../package.json',
  '/popup/../../package.json',
  '/%2e%2e/package.json',
  '/..%2fpackage.json',
  '/../dist.zip',
  '/../dist-archive/notes.txt',
];

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
    const run = generate({ 'popup/index.html': POPUP_HTML });
    expect(run.signal).toBeNull();
    expect(run.status).toBe(0);
    expect(run.stderr).toBe('');
    expect(run.stdout).toContain(LAUNCHED);
    expect(run.stdout.split('\n').filter((line) => line === `${LOADED} 200`)).toHaveLength(CAPTURES.length);
    // The script reads the user agent from the page's navigator, not from
    // Node's, on every version of Node.
    expect(run.stdout.split('\n').filter((line) => line === `${USER_AGENT_SET} ${CHROME_USER_AGENT}`)).toHaveLength(
      CAPTURES.length,
    );
    expect(run.stdout).toContain('All screenshots generated.');
    expect(readdirSync(run.dir).sort()).toEqual([...CAPTURES, 'checksums.json'].sort());
  }, WAIT_MS * 2);

  it('answers 404 for request paths that resolve outside dist/ and still serves the popup page (#171)', () => {
    const served = ['/', '/popup/index.html', '/popup/../popup/index.html'];
    const run = generate(
      { 'popup/index.html': POPUP_HTML },
      { outside: OUTSIDE, requests: [...OUTSIDE_REQUESTS, '/popup', ...served] },
    );
    expect(answers(run.stdout)).toEqual([
      ...OUTSIDE_REQUESTS.map((path) => ({ path, status: 404, body: 'Not found' })),
      // A directory under dist/ is not a file to serve.
      { path: '/popup', status: 404, body: 'Not found' },
      ...served.map((path) => ({ path, status: 200, body: POPUP_HTML })),
    ]);
    expect(run.signal).toBeNull();
    expect(run.status).toBe(0);
    expect(run.stderr).toBe('');
    expect(run.stdout).toContain('All screenshots generated.');
  }, WAIT_MS * 2);
});
