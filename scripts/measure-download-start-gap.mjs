/**
 * Measures how long after Chrome creates a download item an extension
 * observes Chrome's report that the download started in a tab
 * (`Page.downloadWillBegin` on a chrome.debugger session the extension holds
 * there). The extension matches a report to a download item created no later
 * than the report was observed and at most TAB_DOWNLOAD_START_CANDIDATE_MS
 * before it (src/background/download-monitor.ts); this gap is what that
 * limit has to cover.
 *
 * It also times what the extension waits on when it handles an item: the
 * reply to the command it sends each watched session
 * (DOWNLOAD_START_BARRIER_METHOD in src/background/cdp-enforcement.ts, read
 * from there), against the report and chrome.downloads.onCreated.
 *
 * A scratch extension (debugger, downloads and tabs permissions) attaches to
 * one tab, enables the Page domain, and records Date.now() when each report
 * reaches its worker and when chrome.downloads.onCreated does, with the item's
 * startTime. On onCreated it sends that command on the session at once and
 * records when the reply arrives. A local server provides each kind of
 * download, every one at a URL used once so a report and its item pair up by
 * URL:
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
 * A second line per kind gives the report and the reply times less the
 * onCreated time, and how many reports the worker logged before the reply.
 *
 * Last, the page runs a script for 1 s, five times, and the command is sent
 * 100 ms into it, as are Page.getNavigationHistory (the command the extension
 * sent before) and Runtime.evaluate (answered by the page, so it waits for the
 * script); each is also timed with the page idle, and its reply size printed.
 *
 * Measured on Chrome for Testing 145.0.7632.77 and Google Chrome 155.0.8059.84
 * (macOS arm64), 170 downloads each: every report was observed 0-8 ms after
 * the item's startTime, and before chrome.downloads.onCreated.
 *
 * Measured again with the reply timed, on Chrome for Testing 145.0.7632.77
 * (macOS arm64), three runs of 170 downloads: every report was observed 0-11
 * ms after the item's startTime, 0-1 ms before chrome.downloads.onCreated, and
 * before the reply to Inspector.disable, which came 0-16 ms after onCreated.
 * With the page busy, Inspector.disable was answered in 0-2 ms with {} (2
 * bytes), Page.getNavigationHistory in 0-14 ms with 270 bytes, and
 * Runtime.evaluate in 897-906 ms.
 *
 * Run: node scripts/measure-download-start-gap.mjs   (headless, about 100 s)
 * CHROME_PATH selects the browser; the default is the one Puppeteer installed.
 * ROUNDS sets the downloads per kind (default 20).
 */
import puppeteer from 'puppeteer';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROUNDS = Number(process.env.ROUNDS) || 20;
const BURST = 5;
setTimeout(() => { console.log('WATCHDOG: 240s elapsed, aborting'); process.exit(2); }, 240_000).unref();

// The command the extension sends a watched session to learn that no start is
// left to report, read from source so the two stay the same.
const enforcementSrc = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '..', 'src/background/cdp-enforcement.ts'),
  'utf8',
);
const BARRIER = /const DOWNLOAD_START_BARRIER_METHOD = '([A-Za-z]+\.[A-Za-z]+)'/.exec(enforcementSrc)?.[1];
if (!BARRIER) throw new Error('could not read DOWNLOAD_START_BARRIER_METHOD from src/background/cdp-enforcement.ts');

const EXTENSION_WORKER = `
const log = [];
self.gapLog = log;
chrome.debugger.onEvent.addListener((source, method, params) => {
  if (method === 'Page.downloadWillBegin') log.push({ kind: 'start', t: Date.now(), url: params.url });
});
chrome.downloads.onCreated.addListener((item) => {
  log.push({ kind: 'created', t: Date.now(), url: item.url, finalUrl: item.finalUrl, startTime: item.startTime });
  // The command the extension sends when it handles an item, sent here as
  // soon as the item is seen.
  chrome.debugger.sendCommand({ tabId: self.watchedTab }, ${JSON.stringify(BARRIER)}, {}).then(
    () => log.push({ kind: 'reply', t: Date.now(), url: item.url }),
    (err) => log.push({ kind: 'reply', t: Date.now(), url: item.url, error: String(err && err.message) }),
  );
});
self.watch = async (pageUrl) => {
  const [tab] = await chrome.tabs.query({ url: pageUrl });
  await chrome.debugger.attach({ tabId: tab.id }, '1.3');
  await chrome.debugger.sendCommand({ tabId: tab.id }, 'Page.enable', {});
  self.watchedTab = tab.id;
};
self.navigate = (url) => chrome.debugger.sendCommand({ tabId: self.watchedTab }, 'Page.navigate', { url });
// How long one command on the watched session takes to be answered, and its reply.
self.timeCommand = async (method, params) => {
  const t0 = Date.now();
  try {
    const reply = await chrome.debugger.sendCommand({ tabId: self.watchedTab }, method, params);
    return { ms: Date.now() - t0, reply: JSON.stringify(reply === undefined ? null : reply) };
  } catch (err) {
    return { ms: Date.now() - t0, error: String(err && err.message) };
  }
};
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

  const all = { gaps: [], fromCreated: [], replyAfter: [], beforeReply: [], replyFailed: 0 };
  for (const kind of kinds) {
    const gaps = [];
    const reportFirst = [];
    const fromCreated = [];
    const replyAfter = [];
    const beforeReply = [];
    let replyFailed = 0;
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
        const replies = log.filter((e) => e.kind === 'reply').length;
        if (starts >= expected && created >= expected && replies >= created) break;
      }
      const starts = log.filter((e) => e.kind === 'start');
      const replies = log.filter((e) => e.kind === 'reply');
      // "Before" is the order the worker logged the two in, which a shared
      // millisecond cannot tell.
      for (const item of log.filter((e) => e.kind === 'created')) {
        const start = starts.find((s) => s.url === item.url || s.url === item.finalUrl);
        const t = Date.parse(item.startTime);
        if (!start || Number.isNaN(t)) { unpaired += 1; continue; }
        gaps.push(start.t - t);
        reportFirst.push(log.indexOf(start) < log.indexOf(item));
        fromCreated.push(start.t - item.t);
        const reply = replies.find((r) => r.url === item.url);
        if (!reply || reply.error !== undefined) { replyFailed += 1; continue; }
        replyAfter.push(reply.t - item.t);
        beforeReply.push(log.indexOf(start) < log.indexOf(reply));
      }
      unpaired += Math.max(0, starts.length - log.filter((e) => e.kind === 'created').length);
      notStarted += Math.max(0, expected - Math.max(starts.length, log.filter((e) => e.kind === 'created').length));
    }
    for (const list of [gaps, fromCreated, replyAfter]) list.sort((a, b) => a - b);
    all.gaps.push(...gaps);
    all.fromCreated.push(...fromCreated);
    all.replyAfter.push(...replyAfter);
    all.beforeReply.push(...beforeReply);
    all.replyFailed += replyFailed;
    console.log([
      kind.name.padEnd(11),
      `n ${String(gaps.length).padStart(3)}`,
      `| gap ms min ${gaps[0]} median ${quantile(gaps, 0.5)} p95 ${quantile(gaps, 0.95)} max ${gaps[gaps.length - 1]}`,
      `| report observed before onCreated ${reportFirst.filter(Boolean).length}/${reportFirst.length}`,
      `| unpaired ${unpaired}`,
      `| not started ${notStarted} of ${ROUNDS * (kind.count ?? 1)}`,
    ].join(' '));
    console.log([
      ''.padEnd(11),
      `report - onCreated ms min ${fromCreated[0]} max ${fromCreated[fromCreated.length - 1]}`,
      `| reply - onCreated ms min ${replyAfter[0]} max ${replyAfter[replyAfter.length - 1]}`,
      `| report observed before the reply ${beforeReply.filter(Boolean).length}/${beforeReply.length}`,
      `| reply failed ${replyFailed}`,
    ].join(' '));
  }
  for (const list of [all.gaps, all.fromCreated, all.replyAfter]) list.sort((a, b) => a - b);
  const { gaps, fromCreated, replyAfter, beforeReply } = all;
  console.log(`all        n ${gaps.length} | gap ms min ${gaps[0]} median ${quantile(gaps, 0.5)} p95 ${quantile(gaps, 0.95)} max ${gaps[gaps.length - 1]}`);
  console.log([
    `all        report - onCreated ms min ${fromCreated[0]} max ${fromCreated[fromCreated.length - 1]}`,
    `| ${BARRIER} reply - onCreated ms min ${replyAfter[0]} max ${replyAfter[replyAfter.length - 1]}`,
    `| report observed before the reply ${beforeReply.filter(Boolean).length}/${beforeReply.length}`,
    `| reply failed ${all.replyFailed}`,
  ].join(' '));

  // Whether a command waits for a busy page: the page runs a script for 1 s
  // and the command is sent 100 ms into it. Runtime.evaluate is answered by
  // the page, so it waits for the script to end.
  await page.goto(`${origin}/page.html`);
  const probes = [
    [BARRIER, {}],
    // The command the extension sent before, which replies with the tab's history.
    ...(BARRIER === 'Page.getNavigationHistory' ? [] : [['Page.getNavigationHistory', {}]]),
    ['Runtime.evaluate', { expression: '1' }],
  ];
  for (const [method, params] of probes) {
    const idle = [];
    const busy = [];
    let reply = '';
    for (let i = 0; i < 5; i += 1) {
      const quiet = await worker.evaluate((m, p) => self.timeCommand(m, p), method, params);
      idle.push(quiet.ms);
      reply = quiet.error !== undefined ? `error ${quiet.error}` : quiet.reply;
      await page.evaluate(() => { setTimeout(() => { const end = Date.now() + 1000; while (Date.now() < end); }, 0); });
      await wait(100);
      busy.push((await worker.evaluate((m, p) => self.timeCommand(m, p), method, params)).ms);
      await wait(1100);
    }
    idle.sort((a, b) => a - b);
    busy.sort((a, b) => a - b);
    console.log([
      method.padEnd(26),
      `| idle ms min ${idle[0]} max ${idle[idle.length - 1]}`,
      `| busy page ms min ${busy[0]} max ${busy[busy.length - 1]}`,
      `| reply ${reply.length} bytes${reply.length <= 40 ? ` ${reply}` : ''}`,
    ].join(' '));
  }
} finally {
  await browser.close();
  server.close();
  rmSync(work, { recursive: true, force: true });
}
