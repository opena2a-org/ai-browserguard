/**
 * docs/screenshots/capture.mjs closes its browser and exits 1 when a step
 * fails (#159).
 *
 * The script ended with `main().catch(console.error)`. When a step after the
 * launch threw, browser.close() was not reached: the error was printed and
 * the open browser kept the process running. When the launch threw, the
 * process exited 0.
 *
 * Each case runs a copy of the script, and of scripts/screenshot-checksums.mjs,
 * which it imports, in a temporary directory laid out like the repository
 * whose node_modules/puppeteer is a stand-in. Its browser keeps the process
 * running until close() is called, as a launched browser does, and prints a
 * line when it is closed. Its page reports one embedded popup capture, and
 * each screenshot writes a file. The step named in STAND_IN_FAIL_AT throws; a
 * screenshot throws the error Node gives for a file it may not create.
 *
 * The copy starts with a checksums.json holding only the popup capture
 * checksums of scripts/generate-screenshots.mjs (#161).
 */
import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'child_process';
import { createHash } from 'crypto';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { fileURLToPath } from 'url';

const REPO = fileURLToPath(new URL('../../', import.meta.url));
// How long a copy may run before it counts as still running and is stopped.
const WAIT_MS = 10_000;
const CLOSED = 'stand-in browser closed';
// The popup capture the stand-in page embeds, and the bytes of that capture
// and of each image the stand-in browser saves.
const EMBEDDED = '1-detection.png';
const POPUP_CAPTURE = 'stand-in popup capture';
const SAVED_IMAGE = 'stand-in store image';
const CHECKSUMS = JSON.stringify({ popupCaptures: { files: { [EMBEDDED]: 'recorded by generate-screenshots' } } }, null, 2) + '\n';

const STAND_IN = `
import { writeFileSync } from 'fs';

const failAt = process.env.STAND_IN_FAIL_AT;

function step(name, message) {
  if (name === failAt) throw new Error(message || name + ' failed');
}

export default {
  async launch() {
    step('launch');
    const open = setInterval(() => {}, 1000);
    const element = {
      async screenshot({ path }) {
        step('screenshot', "EACCES: permission denied, open '" + path + "'");
        writeFileSync(path, '${SAVED_IMAGE}');
      },
    };
    const page = {
      async goto() { step('goto'); },
      async evaluate() { step('evaluate'); return ['${EMBEDDED}']; },
      async $() { return element; },
    };
    return {
      async newPage() { step('newPage'); return page; },
      async close() {
        clearInterval(open);
        console.log('${CLOSED}');
      },
    };
  },
};
`;

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/**
 * Run a copy of capture.mjs with the stand-in browser, whose step `failAt`
 * throws, and stop it when it has not exited after WAIT_MS. `dir` is the
 * copy's docs/screenshots directory, and `checksums` its checksums.json after
 * the run.
 */
function capture(failAt = '') {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'screenshot-capture-')));
  dirs.push(root);
  const dir = join(root, 'docs', 'screenshots');
  mkdirSync(dir, { recursive: true });
  mkdirSync(join(root, 'scripts'));
  copyFileSync(join(REPO, 'docs', 'screenshots', 'capture.mjs'), join(dir, 'capture.mjs'));
  copyFileSync(join(REPO, 'scripts', 'screenshot-checksums.mjs'), join(root, 'scripts', 'screenshot-checksums.mjs'));
  writeFileSync(join(dir, EMBEDDED), POPUP_CAPTURE);
  writeFileSync(join(dir, 'checksums.json'), CHECKSUMS);
  const standIn = join(root, 'node_modules', 'puppeteer');
  mkdirSync(standIn, { recursive: true });
  writeFileSync(join(standIn, 'package.json'), '{"name": "puppeteer", "type": "module", "exports": "./index.js"}\n');
  writeFileSync(join(standIn, 'index.js'), STAND_IN);
  const run = spawnSync(process.execPath, [join(dir, 'capture.mjs')], {
    cwd: root,
    encoding: 'utf-8',
    env: { ...process.env, STAND_IN_FAIL_AT: failAt },
    timeout: WAIT_MS,
  });
  const closes = run.stdout.split('\n').filter((line) => line === CLOSED).length;
  const checksums = readFileSync(join(dir, 'checksums.json'), 'utf-8');
  return { dir, status: run.status, signal: run.signal, stdout: run.stdout, stderr: run.stderr, closes, checksums };
}

describe('docs/screenshots/capture.mjs', () => {
  it('closes the browser, prints Done and exits 0 when every step succeeds', () => {
    const run = capture();
    expect(run.signal).toBeNull();
    expect(run.status).toBe(0);
    expect(run.stdout).toContain('Saved: store-1-detection.png');
    expect(run.stdout).toContain('Done.');
    expect(run.closes).toBe(1);
  }, WAIT_MS * 2);

  it('records the checksums of the images it saved and of the embedded popup captures, keeping the popup capture section (#161)', () => {
    const run = capture();
    expect(run.status).toBe(0);
    const saved = run.stdout.split('\n')
      .filter((line) => line.startsWith('Saved: '))
      .map((line) => line.slice('Saved: '.length));
    expect(saved).toContain('store-1-detection.png');
    expect(JSON.parse(run.checksums)).toEqual({
      ...JSON.parse(CHECKSUMS),
      storeImages: {
        files: Object.fromEntries(saved.map((name) => [name, sha256(SAVED_IMAGE)])),
        embeddedPopupCaptures: { [EMBEDDED]: sha256(POPUP_CAPTURE) },
      },
    });
  }, WAIT_MS * 2);

  it.each(['newPage', 'goto', 'evaluate', 'screenshot'])(
    'closes the browser, prints the error and exits 1 when %s throws (#159)',
    (step) => {
      const run = capture(step);
      const error = step === 'screenshot'
        ? `EACCES: permission denied, open '${join(run.dir, 'store-1-detection.png')}'`
        : `${step} failed`;
      // A signal here means the copy was still running after WAIT_MS.
      expect(run.signal).toBeNull();
      expect(run.status).toBe(1);
      expect(run.stderr).toContain(error);
      expect(run.closes).toBe(1);
      expect(run.stdout).not.toContain('Done.');
      // A run that fails records no checksums (#161).
      expect(run.checksums).toBe(CHECKSUMS);
    },
    WAIT_MS * 2,
  );

  it('prints the error and exits 1 when the browser does not launch (#159)', () => {
    const run = capture('launch');
    expect(run.signal).toBeNull();
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('launch failed');
    expect(run.closes).toBe(0);
    expect(run.checksums).toBe(CHECKSUMS);
  }, WAIT_MS * 2);
});
