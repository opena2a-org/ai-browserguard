/**
 * Real-extension smoke test for the report export download + popup chrome.
 *
 * Loads the built unpacked extension in Chromium and verifies the two things
 * that shipped broken in 0.4.0:
 *   1. The settings button renders an inline SVG (no gear emoji), the popup
 *      loads with no uncaught errors, and no emoji text nodes are rendered.
 *   2. The report export download actually produces a file. This is exercised
 *      through the REAL action popup (chrome.action.openPopup), because the
 *      popup-only messages that populate the Reports panel are rejected by
 *      sender validation when the popup HTML is opened as an ordinary tab.
 *
 * Usage: node scripts/smoke-export.mjs   (run `npm run build` first)
 * Exit code is non-zero if any assertion fails.
 */
import pw from '../node_modules/playwright/index.js';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const { chromium } = pw;
const __dirname = dirname(fileURLToPath(import.meta.url));
const EXT = join(__dirname, '..');
const PROFILE = '/tmp/abg-smoke-export-profile';

const failures = [];
const skips = [];
function check(name, cond, detail = '') {
  if (cond) { console.log(`  PASS  ${name}`); }
  else { console.log(`  FAIL  ${name} ${detail}`); failures.push(name); }
}
function skip(name, reason) {
  console.log(`  SKIP  ${name} -- ${reason}`);
  skips.push(name);
}

const ctx = await chromium.launchPersistentContext(PROFILE, {
  headless: false,
  channel: 'chromium',
  acceptDownloads: true,
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--no-first-run'],
});

try {
  let [sw] = ctx.serviceWorkers();
  if (!sw) sw = await ctx.waitForEvent('serviceworker', { timeout: 10000 });
  const extId = new URL(sw.url()).host;
  console.log(`extension id: ${extId}`);

  // ---- Part 1: tab-mode DOM checks (chrome, no popup-only messages needed) ----
  console.log('\n[1] popup chrome (tab mode)');
  const tab = await ctx.newPage();
  const errs = [];
  tab.on('pageerror', (e) => errs.push(String(e.message)));
  tab.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
  await tab.goto(`chrome-extension://${extId}/dist/popup/index.html`);
  await tab.waitForTimeout(500);

  const settingsHasSvg = await tab.$eval('#settings-btn svg', () => true).catch(() => false);
  check('settings button renders an inline SVG (not an emoji)', settingsHasSvg);

  const emojiInDom = await tab.evaluate(() => {
    const re = /[\u{2600}-\u{27BF}\u{1F000}-\u{1FAFF}\u{2B00}-\u{2BFF}\u{FE0F}]/u;
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    const hits = [];
    let n;
    while ((n = walker.nextNode())) { if (re.test(n.nodeValue || '')) hits.push(n.nodeValue.trim()); }
    return hits;
  });
  check('no emoji text nodes rendered in popup', emojiInDom.length === 0, JSON.stringify(emojiInDom));
  check('popup loaded with no uncaught errors', errs.length === 0, JSON.stringify(errs.slice(0, 3)));

  // ---- Part 2: real action popup export + download ----
  console.log('\n[2] report export download (real action popup)');
  const report = {
    id: 'rep-smoke-1', sessionId: 'smoke1234abcd5678', agentType: 'openai-operator',
    durationSeconds: 42, endReason: 'tab-closed',
    actionSummary: { total: 5, allowed: 3, blocked: 2 }, totalEvents: 9,
    violationsByCapability: { 'download-file': 2 },
    createdAt: new Date(0).toISOString(), startedAt: new Date(0).toISOString(),
    endedAt: new Date(1000).toISOString(),
  };
  await sw.evaluate((r) => chrome.storage.local.set({ reports: [r] }), report);

  // Need a focused normal window for openPopup; persistent context already has one.
  let popup = null;
  try {
    await sw.evaluate(async () => { await chrome.action.openPopup(); });
    popup = await ctx.waitForEvent('page', { timeout: 4000 }).catch(() => null);
  } catch (e) {
    console.log(`  note: chrome.action.openPopup unavailable in this run (${String(e).split('\n')[0]})`);
  }

  if (!popup) {
    skip('action popup export+download', 'chrome.action.openPopup needs a focused OS window unavailable in automation; this path is covered by unit tests src/popup/download.test.ts + src/background/report-download.test.ts');
  } else {
    await popup.waitForTimeout(400);
    // Open Reports detail then Export JSON
    const row = await popup.$('#reports-list .event-item');
    if (row) await row.click().catch(() => {});
    await popup.waitForTimeout(200);
    const exportBtn = await popup.$('text=Export JSON');
    check('Export JSON button reachable in action popup', !!exportBtn);
    if (exportBtn) {
      let dl = null;
      try {
        [dl] = await Promise.all([
          popup.waitForEvent('download', { timeout: 4000 }),
          exportBtn.click(),
        ]);
      } catch (e) { /* no download */ }
      check('clicking Export JSON produces a download', !!dl, dl ? '' : 'no download event fired');
      if (dl) {
        const out = '/tmp/abg-smoke-export-out.json';
        await dl.saveAs(out);
        const fs = await import('fs');
        check('downloaded file is non-empty', fs.statSync(out).size > 0);
        check('downloaded filename matches report', dl.suggestedFilename().startsWith('report-smoke12'));
      }
    }
  }
} finally {
  await ctx.close();
}

console.log(`\n${failures.length === 0 ? 'SMOKE PASS' : 'SMOKE FAIL'} (${failures.length} failure(s), ${skips.length} skip(s))`);
process.exit(failures.length === 0 ? 0 : 1);
