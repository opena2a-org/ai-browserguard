/**
 * Playwright detection smoke.
 *
 * Loads the built dist/ as an unpacked extension in the Chromium build that
 * Playwright installs, drives a local page with the real Playwright framework,
 * and records what the extension detects. It checks the two signals the
 * Detected Frameworks page lists for Playwright:
 *
 *   1. The stack a page sees inside page.evaluate() carries Playwright's
 *      `UtilityScript` frames, and the extension's session for the page
 *      records an "Agent detected: Playwright" entry.
 *   2. chrome.debugger.getTargets(), read from the extension, lists the driven
 *      page as attached.
 *
 * It also prints the agent type the session names, which is the agent most
 * recently detected in the tab and is not asserted.
 *
 * Run after `npm run build`. The browser is the Chromium build Playwright
 * installs (`npx playwright install chromium`).
 */
import { chromium } from 'playwright';
import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const distPath = resolve(root, 'dist');

const results = [];
const ok = (name, detail = '') => { results.push({ pass: true }); console.log(`  PASS  ${name}${detail ? ' -- ' + detail : ''}`); };
const fail = (name, detail = '') => { results.push({ pass: false }); console.log(`  FAIL  ${name}${detail ? ' -- ' + detail : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const PAGE_HTML = `<!doctype html><html><head><title>Detection smoke</title></head><body>
<form id="f"><input id="recipient" name="recipient"><button id="submitBtn" type="submit">Send</button></form>
<div id="status">idle</div>
<script>document.getElementById('f').addEventListener('submit',function(e){e.preventDefault();
document.getElementById('status').textContent='SUBMITTED '+document.getElementById('recipient').value;});</script>
</body></html>`;

// Read from a short-lived extension page, not the MV3 service worker, which
// Chrome may stop between reads.
async function onExtensionPage(context, extId, fn, arg) {
  const p = await context.newPage();
  try {
    await p.goto(`chrome-extension://${extId}/popup/index.html`, { waitUntil: 'domcontentloaded' });
    return await p.evaluate(fn, arg);
  } finally {
    await p.close().catch(() => {});
  }
}

async function main() {
  const server = http.createServer((_req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end(PAGE_HTML); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const target = `http://localhost:${server.address().port}/`;

  const profile = mkdtempSync(join(tmpdir(), 'abg-pw-'));
  const context = await chromium.launchPersistentContext(profile, {
    // The full Chromium build in headless mode, not the headless shell.
    channel: 'chromium',
    headless: true,
    args: [`--disable-extensions-except=${distPath}`, `--load-extension=${distPath}`],
  });

  try {
    let [worker] = context.serviceWorkers().filter((w) => w.url().includes('background/index.js'));
    if (!worker) {
      worker = await context
        .waitForEvent('serviceworker', { predicate: (w) => w.url().includes('background/index.js'), timeout: 10000 })
        .catch(() => null);
    }
    if (!worker) { fail('extension service worker registers'); return finish(context, server, profile); }
    const extId = new URL(worker.url()).host;
    ok('extension service worker registers', extId);

    const page = await context.newPage();
    await page.goto(target, { waitUntil: 'domcontentloaded' });

    // The stack a page sees inside page.evaluate(). The extension's MAIN-world
    // script inspects the same frames when the stack is formatted.
    const stack = await page.evaluate(() => new Error('stack-probe').stack ?? '');
    console.log('        page.evaluate() stack:\n' + stack.split('\n').map((l) => '          ' + l).join('\n'));
    if (/UtilityScript/.test(stack)) ok('page.evaluate() stack carries UtilityScript frames');
    else fail('page.evaluate() stack carries UtilityScript frames');

    await page.fill('#recipient', 'agent-input');
    await page.press('#recipient', 'Enter');
    const status = await page.textContent('#status');
    if (/SUBMITTED/.test(status || '')) ok('Playwright drove the form', status);
    else fail('Playwright drove the form', `status="${status}"`);

    const { targets, version } = await onExtensionPage(context, extId, async () => ({
      targets: await new Promise((r) => chrome.debugger.getTargets(r)),
      version: (await navigator.userAgentData.getHighEntropyValues(['uaFullVersion'])).uaFullVersion,
    }));
    console.log(`  INFO  browser version ${version}`);
    const pageTarget = targets.find((t) => t.type === 'page' && t.url === target);
    if (pageTarget?.attached) ok('chrome.debugger.getTargets() lists the driven page as attached');
    else fail('chrome.debugger.getTargets() lists the driven page as attached', JSON.stringify(pageTarget ?? null));

    // Let the background's debugger poll (every 3 s) and the session store settle.
    await sleep(7000);
    const { sessions = [] } = await onExtensionPage(context, extId, (k) => chrome.storage.local.get(k), ['sessions']);
    const session = sessions.find((s) => s.agent?.originUrl === target) ?? null;
    const agent = session?.agent ?? null;
    if (agent) ok('extension recorded a session for the driven page', `${agent.type} / ${agent.confidence} / ${agent.detectionMethods.join(',')}`);
    else { fail('extension recorded a session for the driven page', `${sessions.length} session(s) stored`); return finish(context, server, profile); }
    const detections = session.events.filter((e) => e.type === 'detection').map((e) => e.description);
    console.log(`        session detections, oldest first: ${detections.join(' | ')}`);
    if (detections.includes('Agent detected: Playwright')) ok('the session timeline records a Playwright detection');
    else fail('the session timeline records a Playwright detection');
    // Not asserted: the session names the agent most recently detected in its
    // tab, so a generic detection after the Playwright one relabels it.
    console.log(`  INFO  the session names the agent ${agent.type}`);

    return finish(context, server, profile);
  } catch (e) {
    fail('smoke harness ran without throwing', String(e && e.stack ? e.stack : e).split('\n').slice(0, 4).join(' | '));
    return finish(context, server, profile);
  }
}

async function finish(context, server, profile) {
  await context.close().catch(() => {});
  server.close();
  rmSync(profile, { recursive: true, force: true });
  const passed = results.filter((r) => r.pass).length;
  const failed = results.filter((r) => !r.pass).length;
  console.log(`\n${failed === 0 ? 'ALL GREEN' : 'FAILURES'}: ${passed} passed, ${failed} failed`);
  process.exitCode = failed === 0 ? 0 : 1;
}

main().catch((e) => { console.error('smoke harness crashed:', e); process.exitCode = 1; });
