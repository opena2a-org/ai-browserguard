/**
 * Arming smoke test — closes release-smoke step 3 (never before exercised
 * end to end): a delegation rule armed through the REAL toolbar popup wizard
 * must make the in-page monitor block a synthetic agent action and render the
 * block toast.
 *
 * Field-test F-P found the block ENGINE sound but unreachable in practice.
 * This smoke drives the full user path on the built dist/:
 *   1. Load dist/ in a real (headful) Chrome; serve the in-page agent fixture
 *      over localhost.
 *   2. Open the real toolbar popup (chrome.action.openPopup) and walk the
 *      Configure wizard: Read-Only preset -> site pattern -> duration ->
 *      Activate Delegation.
 *   3. Assert the rule PERSISTED (chrome.storage delegationRules) — the
 *      wizard-persistence question the field test could not answer.
 *   4. Drive the fixture's violation phase and assert a monitor block: the
 *      inline toast (.abg-toast) renders and a blocked event lands in the
 *      stored session timeline.
 *
 * Run: npm run smoke:arming   (headful; needs a display)
 */
import puppeteer from 'puppeteer';
import { createServer } from 'node:http';
import { readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dist = resolve(root, 'dist');
const fixtureHtml = readFileSync(resolve(root, 'scripts/inpage-agent-fixture.html'), 'utf8');

const results = [];
const ok = (n, d = '') => { results.push([true, n]); console.log(`  PASS  ${n}${d ? ' -- ' + d : ''}`); };
const bad = (n, d = '') => { results.push([false, n]); console.log(`  FAIL  ${n}${d ? ' -- ' + d : ''}`); };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
setTimeout(() => { console.log('\nWATCHDOG: 150s elapsed, aborting'); process.exit(2); }, 150_000);

// ── fixture server ───────────────────────────────────────────────────────────
const server = createServer((_req, res) => {
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end(fixtureHtml);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const fixtureUrl = `http://127.0.0.1:${server.address().port}/`;

const browser = await puppeteer.launch({
  headless: false,
  userDataDir: mkdtempSync(join(tmpdir(), 'abg-arming-')),
  protocolTimeout: 20_000,
  args: [
    `--disable-extensions-except=${dist}`,
    `--load-extension=${dist}`,
    '--no-first-run', '--no-default-browser-check', '--window-size=1200,900',
  ],
});

/** Click the first button inside `sel` scope whose trimmed text matches. */
async function clickByText(page, text, scope = 'body') {
  const clicked = await page.evaluate((t, s) => {
    const rootEl = document.querySelector(s);
    if (!rootEl) return false;
    const btn = Array.from(rootEl.querySelectorAll('button'))
      .find((b) => b.textContent && b.textContent.trim().startsWith(t));
    if (!btn) return false;
    btn.click();
    return true;
  }, text, scope);
  if (!clicked) throw new Error(`no button "${text}" in ${scope}`);
}

try {
  const swTarget = await browser.waitForTarget(
    (t) => t.type() === 'service_worker' && t.url().startsWith('chrome-extension://'),
    { timeout: 15000 },
  );
  const sw = await swTarget.worker();
  const extId = new URL(swTarget.url()).host;

  // ── real popup: walk the Configure wizard ─────────────────────────────────
  // openPopup requires an ACTIVE (OS-focused) window, so this runs FIRST —
  // the freshly-spawned Chrome briefly holds OS focus; every second of other
  // work erodes that window. (chrome.windows.update cannot steal focus back
  // from another app on macOS.) A run that cannot get focus is a SKIP-worthy
  // environment problem, but the assertions below fail loudly rather than
  // silently passing.
  console.log('  step: opening popup (fresh-launch focus)');
  // Within-Chrome activation: mark a real page target active first —
  // openPopup needs an "active browser window", and a never-activated
  // fresh profile may not have one.
  const warm = await browser.newPage();
  await warm.goto('about:blank');
  await warm.bringToFront();
  await wait(300);
  let openResult = '';
  for (let attempt = 0; attempt < 6 && openResult !== 'ok'; attempt++) {
    openResult = await sw.evaluate(() => {
      if (typeof chrome === 'undefined' || !chrome.action?.openPopup) return 'apis-not-ready';
      return chrome.action.openPopup().then(() => 'ok', (e) => `rejected: ${e}`);
    });
    console.log(`  step: openPopup attempt ${attempt + 1} -> ${openResult}`);
    if (openResult !== 'ok') await wait(500);
  }
  if (openResult !== 'ok') {
    // chrome.action.openPopup needs an OS-focused Chrome window. macOS will
    // not let a background-spawned Chrome steal focus while the user is
    // actively working, so this is an environment limit, not a product
    // failure — and it must surface as an explicit SKIP, never a false pass.
    console.log('\nARMING SMOKE SKIP-ENV: no OS focus for chrome.action.openPopup.');
    console.log('Re-run on an idle desktop (hands off keyboard/mouse for ~60s).');
    await browser.close();
    server.close();
    process.exit(3);
  }
  const popupTarget = await browser.waitForTarget(
    (t) => t.url().includes(extId) && t.url().includes('popup'), { timeout: 5000 },
  );
  const popup = (await popupTarget.page()) ?? (await popupTarget.asPage());
  await popup.waitForSelector('#delegation-wizard-btn', { timeout: 5000 });
  await popup.click('#delegation-wizard-btn');
  await popup.waitForSelector('#wizard-container .preset-card', { timeout: 5000 });

  // Selecting the Read-Only preset (first card) jumps STRAIGHT to the confirm
  // step — only the 'limited' preset visits the sites/time steps
  // (selectPreset: nextStep = preset === 'limited' ? 'sites' : 'confirm').
  await popup.evaluate(() => {
    document.querySelector('#wizard-container .preset-card').click();
  });
  await wait(300);
  await clickByText(popup, 'Activate Delegation', '#wizard-container');
  await wait(800);

  // ── wizard persistence (field-test open question) ─────────────────────────
  const persisted = await sw.evaluate(async () => {
    const s = await chrome.storage.local.get('delegationRules');
    const rules = (s.delegationRules ?? []);
    const active = rules.find((r) => r.isActive);
    return active ? { preset: active.preset, isActive: active.isActive } : null;
  });
  if (persisted?.preset === 'readOnly' && persisted.isActive) {
    ok('wizard persisted an ACTIVE Read-Only rule', JSON.stringify(persisted));
  } else {
    bad('wizard persisted an ACTIVE Read-Only rule', JSON.stringify(persisted));
  }

  // ── fixture page: opened AFTER activation — the content script pulls the
  // active rule at startup via STATUS_QUERY, so new tabs arm too. ───────────
  const page = await browser.newPage();
  await page.goto(fixtureUrl, { waitUntil: 'domcontentloaded' });
  await wait(800); // content scripts settle + rule pull
  // Diagnostic: what does the fixture tab's content script actually hold?
  const tabState = await sw.evaluate(async (url) => {
    const tabs = await chrome.tabs.query({ url: `${url}*` });
    if (!tabs.length || tabs[0].id === undefined) return 'no-tab';
    try {
      return await chrome.tabs.sendMessage(tabs[0].id, {
        type: 'STATUS_QUERY', data: {}, sentAt: new Date().toISOString(),
      });
    } catch (e) { return `sendMessage failed: ${e}`; }
  }, fixtureUrl);
  console.log(`  step: fixture tab content state: ${JSON.stringify(tabState)}`);

  // ── detection + violation phase: synthetic agent actions under the rule ───
  await page.bringToFront();
  // Drive the fixture with SYNTHETIC clicks (evaluate) — that is how an
  // in-page agent behaves, and the fixture's #btn-violate unlocks only after
  // its detection spray has run.
  await page.evaluate(() => document.getElementById('btn-detect').click());
  await wait(1200);
  await page.evaluate(() => document.getElementById('btn-stop').click());
  console.log('  step: detection spray done');
  // Let any user-gesture grace window lapse before firing violations.
  await wait(1600);
  await page.evaluate(() => document.getElementById('btn-violate').click());
  await wait(2500);
  console.log('  step: violations fired');

  // The toast body lives in a CLOSED shadow root that page JS cannot pierce;
  // the observable light-DOM signal is its host container, which the toast
  // module creates lazily on the FIRST toast shown (#abg-toast-container).
  const lateState = await sw.evaluate(async (url) => {
    const tabs = await chrome.tabs.query({ url: `${url}*` });
    if (!tabs.length || tabs[0].id === undefined) return 'no-tab';
    try {
      return await chrome.tabs.sendMessage(tabs[0].id, {
        type: 'STATUS_QUERY', data: {}, sentAt: new Date().toISOString(),
      });
    } catch (e) { return `sendMessage failed: ${e}`; }
  }, fixtureUrl);
  console.log(`  step: post-violation content state: ${JSON.stringify(lateState).slice(0, 300)}`);

  const toastHost = await page.evaluate(() => Boolean(document.getElementById('abg-toast-container')));
  if (toastHost) ok('block toast rendered on the page', 'toast host present (created on first toast)');
  else bad('block toast rendered on the page', 'no #abg-toast-container in DOM — no toast ever showed');

  let blocked = 0;
  for (let i = 0; i < 16 && blocked === 0; i++) {
    blocked = await sw.evaluate(async () => {
      const s = await chrome.storage.local.get('sessions');
      const sessions = s.sessions ?? [];
      let blockedEvents = 0;
      for (const sess of sessions) {
        for (const e of sess.events ?? []) {
          if (e.metadata?.outcome === 'blocked' || e.type === 'action-blocked') blockedEvents++;
        }
      }
      return blockedEvents;
    });
    if (blocked === 0) await wait(500);
  }
  if (blocked > 0) ok('blocked action recorded in the stored session timeline', `${blocked} event(s)`);
  else {
    const dump = await sw.evaluate(async () => {
      const s = await chrome.storage.local.get('sessions');
      return (s.sessions ?? []).map((x) => ({
        agent: x.agent?.type, ended: x.endedAt, events: (x.events ?? []).map((e) => `${e.type}:${e.metadata?.outcome}`),
      }));
    });
    bad('blocked action recorded in the stored session timeline', JSON.stringify(dump).slice(0, 400));
  }
} catch (err) {
  bad('arming smoke aborted', String(err).slice(0, 200));
} finally {
  await browser.close();
  server.close();
}

const failures = results.filter(([p]) => !p).length;
console.log(failures ? `\nARMING SMOKE FAIL (${failures} failure(s))` : '\nARMING SMOKE ALL GREEN');
process.exit(failures ? 1 : 0);
