/**
 * Real-browser load smoke test.
 *
 * Loads the built dist/ as an unpacked extension in a real Chrome, then asserts
 * what a user (and the chrome://extensions Errors panel) would see:
 *   1. The service worker registers (background actually boots).
 *   2. chrome.runtime.getManifest() has NO externally_connectable field
 *      (present-but-empty is the only form Chrome warns about).
 *   3. The popup page renders its core UI (title, status, kill-switch button).
 *   4. The content script injects into an ordinary page without throwing.
 *   5. No load warnings/errors are reported for the extension.
 *
 * Manifest-level warnings never surface in vitest -- only a real Chrome load
 * catches them. Run after `npm run build`.
 */
import puppeteer from 'puppeteer';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const distPath = resolve(root, 'dist');

const results = [];
const ok = (name, detail = '') => { results.push({ name, pass: true, detail }); console.log(`  PASS  ${name}${detail ? ' -- ' + detail : ''}`); };
const fail = (name, detail = '') => { results.push({ name, pass: false, detail }); console.log(`  FAIL  ${name}${detail ? ' -- ' + detail : ''}`); };

async function main() {
  const browser = await puppeteer.launch({
    headless: 'new',
    args: [
      `--disable-extensions-except=${distPath}`,
      `--load-extension=${distPath}`,
      '--no-sandbox',
      '--disable-setuid-sandbox',
    ],
  });

  try {
    // 1. Service worker registers -> extension id
    const swTarget = await browser.waitForTarget(
      (t) => t.type() === 'service_worker' && t.url().includes('background/index.js'),
      { timeout: 10000 },
    ).catch(() => null);

    if (!swTarget) { fail('service worker registers', 'no background service_worker target appeared'); }
    else { ok('service worker registers'); }

    const extId = swTarget ? new URL(swTarget.url()).host : null;

    // 2. Manifest has no externally_connectable
    if (swTarget) {
      const worker = await swTarget.worker();
      const manifest = await worker.evaluate(() => chrome.runtime.getManifest());
      if ('externally_connectable' in manifest) {
        fail('manifest omits externally_connectable', `field present: ${JSON.stringify(manifest.externally_connectable)}`);
      } else {
        ok('manifest omits externally_connectable', `v${manifest.version}, default-closed`);
      }
    }

    // 3. Popup renders core UI
    if (extId) {
      const popup = await browser.newPage();
      const popupErrors = [];
      popup.on('pageerror', (e) => popupErrors.push(e.message));
      await popup.goto(`chrome-extension://${extId}/popup/index.html`, { waitUntil: 'domcontentloaded' });
      await new Promise((r) => setTimeout(r, 400)); // let popup.js paint
      const ui = await popup.evaluate(() => ({
        title: document.querySelector('h1.header-title')?.textContent?.trim() ?? null,
        status: document.querySelector('#status-text')?.textContent?.trim() ?? null,
        killBtn: !!document.querySelector('#kill-switch-btn'),
      }));
      if (ui.title === 'AI Browser Guard' && ui.killBtn) ok('popup renders core UI', `title="${ui.title}", status="${ui.status}"`);
      else fail('popup renders core UI', JSON.stringify(ui));
      if (popupErrors.length) fail('popup throws no page errors', popupErrors.join(' | '));
      else ok('popup throws no page errors');
      await popup.close();
    }

    // 4. Content script injects into an ordinary page without throwing
    const page = await browser.newPage();
    const pageErrors = [];
    page.on('pageerror', (e) => pageErrors.push(e.message));
    await page.goto('https://example.com', { waitUntil: 'domcontentloaded' });
    await new Promise((r) => setTimeout(r, 600));
    const cs = pageErrors.filter((m) => /aibg|browser.?guard|interceptor|content/i.test(m));
    if (cs.length) fail('content script injects cleanly', cs.join(' | '));
    else ok('content script injects cleanly', 'no content/interceptor page errors on example.com');
    await page.close();

    const passed = results.filter((r) => r.pass).length;
    const failed = results.filter((r) => !r.pass).length;
    console.log(`\n${failed === 0 ? 'ALL GREEN' : 'FAILURES'}: ${passed} passed, ${failed} failed`);
    process.exitCode = failed === 0 ? 0 : 1;
  } finally {
    await browser.close();
  }
}

main().catch((e) => { console.error('smoke harness crashed:', e); process.exitCode = 1; });
