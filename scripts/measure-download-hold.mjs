/**
 * Measures whether a download can be held: paused by chrome.downloads.pause as
 * soon as chrome.downloads.onCreated reports it, kept paused, then resumed.
 * A download from the site of an agent's page that was not seen starting in
 * the agent's tab could be held this way and cancelled unless the user keeps
 * it, but only if every kind of download resumes reliably after the hold.
 *
 * A scratch extension (downloads permission only) does the pause and resume
 * in Chrome; a local server provides each kind of download:
 *   plain        a static file with Accept-Ranges and a strong ETag
 *   signed URL   a generated export valid for 5 s, no range support, 403 after
 *   blob:        a 24 MB Blob saved through <a download>
 * and two variants where the server closes a connection whose writes stay
 * blocked for 15 s, as a server send or idle timeout does.
 *
 * Measured on Chrome for Testing 145.0.7632.77 (macOS arm64):
 *   plain, held 10 s and 40 s                  complete (same connection)
 *   signed URL, held 10 s and 40 s             complete (same connection)
 *   blob:, held 10 s and 40 s                  complete about 2 s after the
 *                                              pause, still reported paused
 *   plain, server closes during a 30 s hold    complete (resumed with Range
 *                                              and If-Range)
 *   signed URL, server closes during the hold  interrupted, NETWORK_FAILED,
 *                                              no file
 * A paused download from a short-lived URL without range support is lost once
 * the server closes the idle connection, and nothing in the download item
 * tells it apart from a resumable one when it is created, so no download is
 * held.
 *
 * Run: node scripts/measure-download-hold.mjs   (headless, about 4 minutes)
 * CHROME_PATH selects the browser; the default is the one Puppeteer installed.
 */
import puppeteer from 'puppeteer';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, statSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SIZE = 24 * 1024 * 1024;
const CHUNK = 256 * 1024;
const PACE_MS = 60; // about 4 MB/s, so a download is still running when paused
const SEND_TIMEOUT_MS = 15_000;
const SIGNED_URL_VALID_MS = 5_000;

const EXTENSION_WORKER = `
const log = [];
self.measureLog = log;
self.holdMs = 10000;
const rec = (kind, data) => log.push({ t: Date.now(), kind, ...data });
const snap = (id, kind) => chrome.downloads.search({ id }, (r) => {
  const d = r && r[0];
  rec(kind, { state: d && d.state, paused: d && d.paused, error: d && d.error });
});
chrome.downloads.onCreated.addListener((item) => {
  rec('created', { id: item.id });
  chrome.downloads.pause(item.id, () => {
    rec('pause', { err: chrome.runtime.lastError && chrome.runtime.lastError.message });
    setTimeout(() => {
      snap(item.id, 'beforeResume');
      chrome.downloads.resume(item.id, () => {
        rec('resume', { err: chrome.runtime.lastError && chrome.runtime.lastError.message });
      });
    }, self.holdMs);
  });
});
chrome.downloads.onChanged.addListener((delta) => {
  rec('changed', { state: delta.state && delta.state.current, error: delta.error && delta.error.current });
});
`;

const work = mkdtempSync(join(tmpdir(), 'abg-hold-'));
const extDir = join(work, 'ext');
mkdirSync(extDir);
writeFileSync(join(extDir, 'manifest.json'), JSON.stringify({
  manifest_version: 3,
  name: 'download hold measurement',
  version: '0.0.1',
  permissions: ['downloads'],
  background: { service_worker: 'worker.js' },
}));
writeFileSync(join(extDir, 'worker.js'), EXTENSION_WORKER);

const requests = [];
const body = Buffer.alloc(CHUNK, 0x61);

/** Write the body from `start` at a fixed pace; `strict` closes a write blocked too long. */
function stream(req, res, start, strict) {
  let sent = start;
  const tick = () => {
    if (res.destroyed) return;
    if (sent >= SIZE) { res.end(); return; }
    const n = Math.min(CHUNK, SIZE - sent);
    const flushed = res.write(n === CHUNK ? body : body.subarray(0, n));
    sent += n;
    if (flushed) { setTimeout(tick, PACE_MS); return; }
    const timer = strict ? setTimeout(() => {
      requests.push({ t: Date.now(), path: req.url, closedByServer: true });
      res.destroy();
    }, SEND_TIMEOUT_MS) : null;
    res.once('drain', () => { if (timer) clearTimeout(timer); setTimeout(tick, PACE_MS); });
  };
  tick();
}

const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://local');
  requests.push({ t: Date.now(), path: req.url, range: req.headers.range ?? null });
  const strict = url.pathname.startsWith('/strict/');
  if (url.pathname === '/page.html') {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(`<!doctype html><script>
      window.saveBlob = () => { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([new Uint8Array(${SIZE})])); a.download = 'blob.bin'; document.body.appendChild(a); a.click(); };
      window.follow = (href) => { const a = document.createElement('a'); a.href = href; document.body.appendChild(a); a.click(); };
    </script>`);
  } else if (url.pathname.endsWith('/file.bin')) {
    const range = /^bytes=(\d+)-$/.exec(req.headers.range ?? '');
    const start = range ? Number(range[1]) : 0;
    const headers = {
      'content-type': 'application/octet-stream',
      'content-disposition': 'attachment; filename="file.bin"',
      'accept-ranges': 'bytes',
      etag: '"v1"',
      'content-length': String(SIZE - start),
    };
    if (range) res.writeHead(206, { ...headers, 'content-range': `bytes ${start}-${SIZE - 1}/${SIZE}` });
    else res.writeHead(200, headers);
    stream(req, res, start, strict);
  } else if (url.pathname.endsWith('/export')) {
    if (!(Date.now() < Number(url.searchParams.get('expires')))) {
      res.writeHead(403, { 'content-type': 'text/plain' });
      res.end('expired');
      return;
    }
    res.writeHead(200, { 'content-type': 'text/csv', 'content-disposition': 'attachment; filename="export.csv"' });
    stream(req, res, 0, strict);
  } else {
    res.writeHead(404);
    res.end();
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${server.address().port}`;

const signed = (path) => `${path}?expires=${Date.now() + SIGNED_URL_VALID_MS}&signature=x`;
const cases = [
  { name: 'plain, held 10 s', start: (p) => p.evaluate((h) => window.follow(h), '/file.bin'), hold: 10_000 },
  { name: 'plain, held 40 s', start: (p) => p.evaluate((h) => window.follow(h), '/file.bin'), hold: 40_000 },
  { name: 'signed URL, held 10 s', start: (p) => p.evaluate((h) => window.follow(h), signed('/export')), hold: 10_000 },
  { name: 'signed URL, held 40 s', start: (p) => p.evaluate((h) => window.follow(h), signed('/export')), hold: 40_000 },
  { name: 'blob:, held 10 s', start: (p) => p.evaluate(() => window.saveBlob()), hold: 10_000 },
  { name: 'blob:, held 40 s', start: (p) => p.evaluate(() => window.saveBlob()), hold: 40_000 },
  { name: 'plain, server closes during a 30 s hold', start: (p) => p.evaluate((h) => window.follow(h), '/strict/file.bin'), hold: 30_000 },
  { name: 'signed URL, server closes during a 30 s hold', start: (p) => p.evaluate((h) => window.follow(h), signed('/strict/export')), hold: 30_000 },
];

const launchOptions = { headless: true, pipe: true, enableExtensions: [extDir], args: ['--no-first-run', '--no-default-browser-check'] };
if (process.env.CHROME_PATH) launchOptions.executablePath = process.env.CHROME_PATH;

let index = 0;
try {
  for (const c of cases) {
    index += 1;
    const profile = join(work, `profile-${index}`);
    const saved = join(work, `saved-${index}`);
    mkdirSync(join(profile, 'Default'), { recursive: true });
    mkdirSync(saved);
    writeFileSync(join(profile, 'Default', 'Preferences'), JSON.stringify({
      download: { default_directory: saved, prompt_for_download: false, directory_upgrade: true },
    }));
    const browser = await puppeteer.launch({ ...launchOptions, userDataDir: profile });
    try {
      const target = await browser.waitForTarget(
        (t) => t.type() === 'service_worker' && t.url().startsWith('chrome-extension://'),
        { timeout: 15_000 },
      );
      const worker = await target.worker();
      await worker.evaluate((ms) => { self.holdMs = ms; }, c.hold);
      const page = await browser.newPage();
      await page.goto(`${origin}/page.html`);
      requests.length = 0;
      await c.start(page);
      const deadline = Date.now() + c.hold + 40_000;
      let log = [];
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 1000));
        log = await worker.evaluate(() => self.measureLog.slice());
        const resumed = log.some((e) => e.kind === 'resume');
        const ended = log.some((e) => e.kind === 'changed' && (e.state === 'complete' || e.state === 'interrupted'));
        if (resumed && ended) break;
      }
      const end = [...log].reverse().find((e) => e.kind === 'changed' && e.state);
      const atResume = log.find((e) => e.kind === 'beforeResume');
      const files = readdirSync(saved).map((f) => `${f} ${statSync(join(saved, f)).size} bytes`);
      const ranged = requests.filter((r) => r.range).map((r) => r.range);
      console.log([
        c.name.padEnd(46),
        `outcome ${end ? end.state : 'none'}${end && end.error ? ` (${end.error})` : ''}`,
        `| at resume: ${atResume ? `${atResume.state}${atResume.paused ? ', paused' : ''}` : 'n/a'}`,
        `| range requests: ${ranged.length ? ranged.join(' ') : 'none'}`,
        `| saved: ${files.length ? files.join(', ') : 'nothing'}`,
      ].join(' '));
    } finally {
      await browser.close();
    }
  }
} finally {
  server.close();
  rmSync(work, { recursive: true, force: true });
}
