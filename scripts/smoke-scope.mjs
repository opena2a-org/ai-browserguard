/**
 * Enforcement-scope smoke test (ADR-008).
 *
 * Loads the built dist/ as an unpacked extension, drives a real form with an
 * external CDP framework (Puppeteer == the same class as Playwright/Cowork)
 * using NATIVE input, and asserts the report states its observation scope:
 *
 *   1. The agent is detected (external CDP driver).
 *   2. The native-input form submission actually landed (the agent acted).
 *   3. The session report carries an observation scope
 *      (`coverage.nativeCdpInputObservable === false`) with a note, so its
 *      0-action count is not read as "nothing happened".
 *
 * This is the regression that keeps the report's observation scope aligned with
 * the enforcement scope. Run after `npm run build`.
 *
 * Why an E2E smoke and not just a unit test: the scope invariant spans the
 * content script, the background session lifecycle, report generation, and real
 * CDP-native input semantics (isTrusted) that jsdom cannot reproduce.
 */
import puppeteer from 'puppeteer';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const distPath = resolve(root, 'dist');

const results = [];
const ok = (name, detail = '') => { results.push({ pass: true }); console.log(`  PASS  ${name}${detail ? ' -- ' + detail : ''}`); };
const fail = (name, detail = '') => { results.push({ pass: false }); console.log(`  FAIL  ${name}${detail ? ' -- ' + detail : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const PAGE_HTML = `<!doctype html><html><head><title>Playwright scope smoke</title></head><body>
<form id="f"><input id="recipient" name="recipient"><button id="submitBtn" type="submit">Send</button></form>
<div id="status">idle</div>
<script>document.getElementById('f').addEventListener('submit',function(e){e.preventDefault();
document.getElementById('status').textContent='SUBMITTED '+document.getElementById('recipient').value;});</script>
</body></html>`;

// Read chrome.storage.local from a fresh, short-lived extension page (not the
// evictable MV3 service worker, whose evaluate() can hang). Retries on the
// occasional headless-Chrome protocol timeout so the smoke is CI-stable.
async function readStorage(browser, extId, keys, attempts = 3) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    let p;
    try {
      p = await browser.newPage();
      await p.goto(`chrome-extension://${extId}/popup/index.html`, { waitUntil: 'domcontentloaded' });
      const data = await p.evaluate(async (k) => await chrome.storage.local.get(k), keys);
      await p.close();
      return data;
    } catch (e) {
      lastErr = e;
      try { if (p) await p.close(); } catch { /* already gone */ }
      await sleep(1000);
    }
  }
  throw lastErr;
}

async function main() {
  const server = http.createServer((_req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end(PAGE_HTML); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const target = `http://localhost:${server.address().port}/`;

  const browser = await puppeteer.launch({
    headless: 'new',
    protocolTimeout: 60000,
    args: [`--disable-extensions-except=${distPath}`, `--load-extension=${distPath}`, '--no-sandbox', '--disable-setuid-sandbox'],
  });

  try {
    const swTarget = await browser.waitForTarget(
      (t) => t.type() === 'service_worker' && t.url().includes('background/index.js'),
      { timeout: 10000 },
    ).catch(() => null);
    if (!swTarget) { fail('service worker registers'); return finish(browser, server); }
    const extId = new URL(swTarget.url()).host;

    const page = await browser.newPage();
    await page.goto(target, { waitUntil: 'domcontentloaded' });

    // Drive with native CDP input (== Playwright/Cowork). Submit via a native
    // Enter keypress rather than page.click(): clicking computes element geometry
    // via Runtime.callFunctionOn, which is the flaky call under headless load;
    // implicit form submission on Enter is the same native-input path we assert.
    await page.type('#recipient', 'attacker-acct-9931');
    await page.focus('#recipient');
    await page.keyboard.press('Enter');
    await sleep(400);
    const status = await page.$eval('#status', (el) => el.textContent);
    if (/SUBMITTED/.test(status || '')) ok('external agent drove the form via native input', status);
    else fail('external agent drove the form via native input', `status="${status}"`);

    // Let the extension's detection poll fire (interval ~3s), then read once.
    await sleep(9000);
    const agent = (await readStorage(browser, extId, ['sessions'])).sessions?.[0]?.agent ?? null;
    if (agent) ok('external CDP agent detected', `${agent.type} / ${agent.confidence}`);
    else { fail('external CDP agent detected', 'no session recorded'); return finish(browser, server); }

    // End the session and read the report.
    await page.close();
    await sleep(2500);
    const report = ((await readStorage(browser, extId, ['reports'])).reports || [])[0] || null;
    if (!report) { fail('session report generated'); return finish(browser, server); }
    ok('session report generated', `actions=${report.actionSummary.total}`);

    // SCOPE INVARIANT: a report for an external CDP driver must state that native
    // input was not observable, so its 0-count is not read as an all-clear.
    if (report.coverage && report.coverage.nativeCdpInputObservable === false) {
      ok('report states native input NOT observable (0 is not an all-clear)');
    } else {
      fail('report declares native input NOT observable', `coverage=${JSON.stringify(report.coverage)}`);
    }
    if (report.coverage?.note && /not observable|not included/i.test(report.coverage.note)) {
      ok('report carries an observability-scope note');
    } else {
      fail('report carries an observability-scope note', JSON.stringify(report.coverage?.note));
    }

    return finish(browser, server);
  } catch (e) {
    fail('smoke harness ran without throwing', String(e && e.stack ? e.stack : e).split('\n').slice(0, 4).join(' | '));
    return finish(browser, server);
  }
}

async function finish(browser, server) {
  await browser.close();
  server.close();
  const passed = results.filter((r) => r.pass).length;
  const failed = results.filter((r) => !r.pass).length;
  console.log(`\n${failed === 0 ? 'ALL GREEN' : 'FAILURES'}: ${passed} passed, ${failed} failed`);
  process.exitCode = failed === 0 ? 0 : 1;
}

main().catch((e) => { console.error('smoke harness crashed:', e); process.exitCode = 1; });
