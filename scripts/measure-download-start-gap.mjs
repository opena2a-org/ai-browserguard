/**
 * Measures how long after Chrome creates a download item an extension
 * observes Chrome's report that the download started in a tab
 * (`Page.downloadWillBegin` on a chrome.debugger session the extension holds
 * there). The extension matches a report to a download item created no later
 * than the report was observed and at most TAB_DOWNLOAD_START_CANDIDATE_MS
 * before it (src/background/download-monitor.ts); this gap is what that
 * limit has to cover.
 *
 * A scratch extension (debugger, downloads and tabs permissions) attaches to
 * one tab, enables the Page domain, and records Date.now() when each report
 * reaches its worker and when chrome.downloads.onCreated does, with the item's
 * startTime. A local server provides each kind of download, every one at a
 * URL used once so a report and its item pair up by URL:
 *   link          an <a> click to a response with Content-Disposition: attachment
 *   a download    an <a download> click to a same-origin file
 *   blob:         a Blob saved through <a download>
 *   redirect      an <a> click to a 302 whose target is an attachment
 *   navigation    the tab navigated to an attachment by Page.navigate, as a
 *                 driver does
 *   burst         five <a download> clicks in one task
 *
 * Gap = time the report was observed - startTime. A negative gap is a report
 * observed before the item's startTime. Chrome does not start every download
 * of a burst; one with neither an item nor a report is counted as not started.
 *
 * Measured on Chrome for Testing 145.0.7632.77 and Google Chrome 155.0.8059.84
 * (macOS arm64), 170 downloads each: every report was observed 0-8 ms after
 * the item's startTime, and before chrome.downloads.onCreated.
 *
 * Run: node scripts/measure-download-start-gap.mjs   (headless, about 80 s)
 * CHROME_PATH selects the browser; the default is the one Puppeteer installed.
 * ROUNDS sets the downloads per kind (default 20).
 */
import puppeteer from 'puppeteer';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROUNDS = Number(process.env.ROUNDS) || 20;
const BURST = 5;
setTimeout(() => { console.log('WATCHDOG: 240s elapsed, aborting'); process.exit(2); }, 240_000).unref();

const EXTENSION_WORKER = `
const log = [];
self.gapLog = log;
chrome.debugger.onEvent.addListener((source, method, params) => {
  if (method === 'Page.downloadWillBegin') log.push({ kind: 'start', t: Date.now(), url: params.url });
});
chrome.downloads.onCreated.addListener((item) => {
  log.push({ kind: 'created', t: Date.now(), url: item.url, finalUrl: item.finalUrl, startTime: item.startTime });
});
self.watch = async (pageUrl) => {
  const [tab] = await chrome.tabs.query({ url: pageUrl });
  await chrome.debugger.attach({ tabId: tab.id }, '1.3');
  await chrome.debugger.sendCommand({ tabId: tab.id }, 'Page.enable', {});
  self.watchedTab = tab.id;
};
self.navigate = (url) => chrome.debugger.sendCommand({ tabId: self.watchedTab }, 'Page.navigate', { url });
// An extension API call keeps the worker from being stopped as idle.
setInterval(() => chrome.runtime.getPlatformInfo(), 10000);
`;

const work = mkdtempSync(join(tmpdir(), 'abg-gap-'));
const extDir = join(work, 'ext');
const profile = join(work, 'profile');
const saved = join(work, 'saved');
mkdirSync(extDir);
mkdirSync(join(profile, 'Default'), { recursive: true });
mkdirSync(saved);
writeFileSync(join(extDir, 'manifest.json'), JSON.stringify({
  manifest_version: 3,
  name: 'download start gap measurement',
  version: '0.0.1',
  permissions: ['debugger', 'downloads', 'tabs'],
  background: { service_worker: 'worker.js' },
}));
writeFileSync(join(extDir, 'worker.js'), EXTENSION_WORKER);
// Automatic downloads allowed: otherwise Chrome lets a page start one download
// without a user gesture and blocks the next.
writeFileSync(join(profile, 'Default', 'Preferences'), JSON.stringify({
  download: { default_directory: saved, prompt_for_download: false, directory_upgrade: true },
  profile: { default_content_setting_values: { automatic_downloads: 1 } },
}));

const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://local');
  if (url.pathname === '/page.html') {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(`<!doctype html><script>
      const click = (href, download) => { const a = document.createElement('a'); a.href = href; if (download) a.download = download; document.body.appendChild(a); a.click(); a.remove(); };
      window.follow = (href) => click(href);
      window.save = (href) => click(href, 'saved.txt');
      window.saveBlob = () => click(URL.createObjectURL(new Blob(['x'.repeat(4096)])), 'blob.txt');
    </script>`);
  } else if (url.pathname === '/file.bin') {
    res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-disposition': 'attachment; filename="file.bin"' });
    res.end(Buffer.alloc(4096, 0x61));
  } else if (url.pathname === '/plain.txt') {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('x'.repeat(4096));
  } else if (url.pathname === '/redirect') {
    res.writeHead(302, { location: `/file.bin?${url.searchParams}` });
    res.end();
  } else {
    res.writeHead(404);
    res.end();
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${server.address().port}`;

let serial = 0;
const fresh = (path) => `${path}?n=${++serial}`;
const kinds = [
  { name: 'link', run: (p) => p.evaluate((h) => window.follow(h), fresh('/file.bin')) },
  { name: 'a download', run: (p) => p.evaluate((h) => window.save(h), fresh('/plain.txt')) },
  { name: 'blob:', run: (p) => p.evaluate(() => window.saveBlob()) },
  { name: 'redirect', run: (p) => p.evaluate((h) => window.follow(h), fresh('/redirect')) },
  { name: 'navigation', run: (p, w) => w.evaluate((h) => self.navigate(h), `${origin}${fresh('/file.bin')}`) },
  {
    name: 'burst',
    count: BURST,
    run: (p) => p.evaluate((hs) => { for (const h of hs) window.save(h); }, Array.from({ length: BURST }, () => fresh('/plain.txt'))),
  },
];

const launchOptions = {
  headless: true,
  pipe: true,
  enableExtensions: [extDir],
  userDataDir: profile,
  args: ['--no-first-run', '--no-default-browser-check'],
};
if (process.env.CHROME_PATH) launchOptions.executablePath = process.env.CHROME_PATH;

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const quantile = (sorted, q) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];

const browser = await puppeteer.launch(launchOptions);
try {
  console.log(`browser ${await browser.version()}, ${ROUNDS} rounds per kind`);
  const target = await browser.waitForTarget(
    (t) => t.type() === 'service_worker' && t.url().startsWith('chrome-extension://'),
    { timeout: 15_000 },
  );
  const worker = await target.worker();
  const page = await browser.newPage();
  await page.goto(`${origin}/page.html`);
  await worker.evaluate((u) => self.watch(u), `${origin}/page.html`);

  const all = [];
  for (const kind of kinds) {
    const gaps = [];
    const reportFirst = [];
    let unpaired = 0;
    let notStarted = 0;
    for (let i = 0; i < ROUNDS; i += 1) {
      if (kind.name === 'navigation') {
        await page.goto(`${origin}/page.html`);
      }
      await worker.evaluate(() => { self.gapLog.length = 0; });
      await kind.run(page, worker);
      const expected = kind.count ?? 1;
      let log = [];
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        await wait(100);
        log = await worker.evaluate(() => self.gapLog.slice());
        const starts = log.filter((e) => e.kind === 'start').length;
        const created = log.filter((e) => e.kind === 'created').length;
        if (starts >= expected && created >= expected) break;
      }
      const starts = log.filter((e) => e.kind === 'start');
      for (const item of log.filter((e) => e.kind === 'created')) {
        const start = starts.find((s) => s.url === item.url || s.url === item.finalUrl);
        const t = Date.parse(item.startTime);
        if (!start || Number.isNaN(t)) { unpaired += 1; continue; }
        gaps.push(start.t - t);
        reportFirst.push(start.t <= item.t);
      }
      unpaired += Math.max(0, starts.length - log.filter((e) => e.kind === 'created').length);
      notStarted += Math.max(0, expected - Math.max(starts.length, log.filter((e) => e.kind === 'created').length));
    }
    gaps.sort((a, b) => a - b);
    all.push(...gaps);
    console.log([
      kind.name.padEnd(11),
      `n ${String(gaps.length).padStart(3)}`,
      `| gap ms min ${gaps[0]} median ${quantile(gaps, 0.5)} p95 ${quantile(gaps, 0.95)} max ${gaps[gaps.length - 1]}`,
      `| report observed before onCreated ${reportFirst.filter(Boolean).length}/${reportFirst.length}`,
      `| unpaired ${unpaired}`,
      `| not started ${notStarted} of ${ROUNDS * (kind.count ?? 1)}`,
    ].join(' '));
  }
  all.sort((a, b) => a - b);
  console.log(`all        n ${all.length} | gap ms min ${all[0]} median ${quantile(all, 0.5)} p95 ${quantile(all, 0.95)} max ${all[all.length - 1]}`);
} finally {
  await browser.close();
  server.close();
  rmSync(work, { recursive: true, force: true });
}
