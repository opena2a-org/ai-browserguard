/**
 * CDP-layer enforcement smoke (ADR-007) — the release gate that takes this
 * feature from "unit-tested" to "proven in a real browser on the built dist/".
 *
 * Ground truth: a local fixture server with a receipt log, reachable as BOTH
 * `allowed.test` and `blocked.test` via --host-resolver-rules. A blocked
 * request never produces a receipt; a passed-through one does. The egress
 * battery fires through every vector the page-realm interceptor never wrapped
 * (EventSource, Image.src, Worker fetch, iframe fetch — plus WebSocket, which is
 * tracked as the documented-open vector). A missing receipt in an enforcement
 * phase is attributable ONLY to the CDP layer, and a present receipt in a
 * fail-safe phase proves fail-open.
 *
 * WebSocket scope: the CDP Fetch domain does not pause ws handshakes, and
 * Network-level ws blocking proved unreliable on the live extension's shared
 * debugger session, so ws is NOT closed by this layer (deterministic ws blocking
 * needs declarativeNetRequest — ADR-008 R2). The battery still fires ws and
 * asserts it stays open with enforcement armed, so the scope line is checked,
 * not assumed.
 *
 * Phases:
 *   A  default-off: delegation armed (allow allowed.test + BLOCK blocked.test,
 *      via the REAL popup wizard), agent detected, setting untouched -> every
 *      vector ARRIVES (default-off proof + the battery's own vacuousness
 *      control + a live demonstration of the page-realm gap ADR-007 closes).
 *   B  enabled via the real popup settings toggle -> every CDP-closable vector
 *      to blocked.test is BLOCKED (zero receipts) while ws stays open,
 *      allowed.test control passes, blocked events land in the stored session
 *      timeline, navigation to the blocked domain fails in the delegated tab,
 *      and the SAME URL still loads in a second, non-delegated tab (per-tab
 *      scope).
 *   C  fail-safe/teardown: setting-off -> fail-open, re-enable -> re-attach,
 *      tab close -> new agent tab re-attaches, delegation EXPIRY (storage
 *      rewrite + browser restart) -> no attach + fail-open, restart with a
 *      valid rule -> self-heal re-attach, kill switch -> full teardown and the
 *      user's browsing passes freely.
 *
 * Needs OS focus for the popup (locked console = SKIP-ENV, exit 3, never a
 * false pass). Run: npm run smoke:cdp   (headful; needs a display)
 */
import puppeteer from 'puppeteer';
import { createServer } from 'node:http';
import { readFileSync, mkdtempSync, mkdirSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { tmpdir, platform } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dist = resolve(root, 'dist');
const fixtureHtml = readFileSync(resolve(root, 'scripts/cdp-egress-fixture.html'), 'utf8');

const results = [];
const ok = (n, d = '') => { results.push([true, n]); console.log(`  PASS  ${n}${d ? ' -- ' + d : ''}`); };
const bad = (n, d = '') => { results.push([false, n]); console.log(`  FAIL  ${n}${d ? ' -- ' + d : ''}`); };
const note = (m) => console.log(`  note: ${m}`);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
setTimeout(() => { console.log('\nWATCHDOG: 360s elapsed, aborting'); process.exit(2); }, 360_000);

// ── fixture server: one origin, two hostnames, receipt log ───────────────────
const receipts = [];
const GIF = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
const server = createServer((req, res) => {
  receipts.push(`${req.headers.host}${req.url}`);
  const cors = { 'access-control-allow-origin': '*' };
  if (req.url.endsWith('/img')) {
    res.writeHead(200, { ...cors, 'content-type': 'image/gif' });
    res.end(GIF);
  } else if (req.url.endsWith('/es')) {
    res.writeHead(200, { ...cors, 'content-type': 'text/event-stream' });
    res.end('data: hello\n\n');
  } else if (req.url === '/' || req.url.startsWith('/?')) {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(fixtureHtml);
  } else {
    res.writeHead(200, { ...cors, 'content-type': 'text/html' });
    res.end('<title>fixture-server</title>ok');
  }
});
server.on('upgrade', (req, socket) => {
  receipts.push(`${req.headers.host}${req.url}`);
  socket.destroy();
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
const ALLOWED = `http://allowed.test:${port}`;
const BLOCKED = `http://blocked.test:${port}`;
const receiptsFor = (path) => receipts.filter((r) => r.includes(path));

// ── browser lifecycle (userDataDir survives relaunches) ──────────────────────
const userDataDir = mkdtempSync(join(tmpdir(), 'abg-cdp-'));
const scratch = process.env.ABG_SMOKE_ARTIFACTS ?? mkdtempSync(join(tmpdir(), 'abg-cdp-artifacts-'));
mkdirSync(scratch, { recursive: true });
let browser = null;
let sw = null;

async function launch() {
  browser = await puppeteer.launch({
    headless: false,
    userDataDir,
    protocolTimeout: 30_000,
    args: [
      `--disable-extensions-except=${dist}`,
      `--load-extension=${dist}`,
      `--host-resolver-rules=MAP allowed.test 127.0.0.1, MAP blocked.test 127.0.0.1`,
      '--no-first-run', '--no-default-browser-check', '--window-size=1200,900',
    ],
  });
  const swTarget = await browser.waitForTarget(
    (t) => t.type() === 'service_worker' && t.url().startsWith('chrome-extension://'),
    { timeout: 15000 },
  );
  sw = await swTarget.worker();
  // The worker target can surface before its chrome.* APIs are usable —
  // evaluating too early sees a partial global (probe reproduced this).
  for (let i = 0; i < 40; i++) {
    const ready = await sw.evaluate(() =>
      typeof chrome !== 'undefined' && !!chrome.storage?.local && !!chrome.tabs,
    ).catch(() => false);
    if (ready) break;
    await wait(250);
  }
  return new URL(swTarget.url()).host;
}

async function relaunch() {
  await browser.close();
  await wait(500);
  return launch();
}

const swStorage = (keys) => sw.evaluate((k) => chrome.storage.local.get(k), keys);

// ── popup driving: every interaction is ONE evaluate round-trip ──────────────
// chrome.action.openPopup needs an OS-focused Chrome window; the popup dies on
// any focus loss. Interactions poll inside the page (safe) and all evidence is
// read from chrome.storage AFTER (0.6.1/0.6.2 lesson).
let extId = null;

/** Bring the (already running) test Chrome frontmost so it has OS focus.
 *  LaunchServices (`open`) needs no Automation/TCC grant, unlike osascript. */
function osActivateChrome() {
  if (platform() !== 'darwin') return Promise.resolve();
  const exe = browser?.process()?.spawnfile ?? '';
  const appIdx = exe.indexOf('.app/');
  const appPath = appIdx > 0 ? exe.slice(0, appIdx + 4) : null;
  if (!appPath) return Promise.resolve();
  return new Promise((r) => execFile('open', [appPath], () => r()));
}

async function ensurePopup() {
  const existing = browser.targets().find((t) => t.url().includes(extId) && t.url().includes('popup'));
  if (existing) return (await existing.page()) ?? (await existing.asPage());
  const warm = await browser.newPage();
  await warm.goto('about:blank');
  await warm.bringToFront();
  await wait(300);
  let openResult = '';
  for (let attempt = 0; attempt < 8 && openResult !== 'ok'; attempt++) {
    openResult = await sw.evaluate(() => {
      if (typeof chrome === 'undefined' || !chrome.action?.openPopup) return 'apis-not-ready';
      return chrome.action.openPopup().then(() => 'ok', (e) => `rejected: ${e}`);
    });
    if (openResult !== 'ok') {
      // openPopup needs an OS-focused Chrome window; a background-spawned
      // Chrome may never get one on its own. The app is already running, so
      // `activate` is a legitimate focus request, not focus stealing.
      await osActivateChrome();
      await wait(600);
    }
  }
  await warm.close().catch(() => {});
  if (openResult !== 'ok') {
    console.log(`\nCDP SMOKE SKIP-ENV: no OS focus for chrome.action.openPopup (${openResult}).`);
    console.log('Re-run on an idle, unlocked desktop (hands off keyboard/mouse).');
    await browser.close().catch(() => {});
    server.close();
    process.exit(3);
  }
  const popupTarget = await browser.waitForTarget(
    (t) => t.url().includes(extId) && t.url().includes('popup'), { timeout: 5000 },
  );
  return (await popupTarget.page()) ?? (await popupTarget.asPage());
}

async function popupDo(fn, arg) {
  const popup = await ensurePopup();
  return popup.evaluate(fn, arg);
}

// ── shared page drivers ──────────────────────────────────────────────────────
async function openFixtureTab() {
  const page = await browser.newPage();
  await page.goto(`${ALLOWED}/`, { waitUntil: 'domcontentloaded' });
  return page;
}

/** Spray synthetic input until ABG's persisted agent registry sees this origin. */
async function sprayUntilAgent(page, label) {
  await page.bringToFront();
  await page.evaluate(() => window.startSpray());
  for (let i = 0; i < 24; i++) {
    const seen = await sw.evaluate(async (needle) => {
      const s = await chrome.storage.local.get('activeAgentRegistry');
      return JSON.stringify(s.activeAgentRegistry ?? '').includes(needle);
    }, 'allowed.test');
    if (seen) { ok(`${label}: in-page agent detected and registered`); return true; }
    await wait(500);
  }
  bad(`${label}: in-page agent detected and registered`, 'registry never saw allowed.test');
  return false;
}

async function runBattery(page, phase) {
  const inPage = await page.evaluate(
    (p, b, a) => window.runEgressBattery(p, b, a), phase, BLOCKED, ALLOWED,
  );
  await wait(400); // let late receipts land
  return inPage;
}

// Vectors the CDP Fetch layer closes reliably (all transit the HTTP stack Fetch
// pauses). WebSocket is tracked separately: the Fetch domain does NOT pause ws
// handshakes and Network-level ws blocking proved unreliable on the live
// extension's shared debugger session, so ws is the ONE documented-open egress
// vector for blocked domains (docs/architecture §8, ADR-007). The battery still
// fires ws every phase so this stays an asserted, regression-guarded scope line,
// not a silent gap.
const CLOSED_VECTORS = ['es', 'img', 'worker-fetch', 'iframe-fetch'];
const ALL_VECTORS = ['ws', ...CLOSED_VECTORS];

function assertBattery(phase, inPage, expectBlocked) {
  if (expectBlocked) {
    const leaked = CLOSED_VECTORS.filter((v) => receiptsFor(`/${phase}/${v}`).length > 0);
    if (leaked.length === 0) {
      ok(`${phase}: every CDP-closable vector blocked`, `zero receipts for ${CLOSED_VECTORS.join(', ')}`);
    } else {
      bad(`${phase}: every CDP-closable vector blocked`, `LEAKED to server: ${leaked.join(', ')}`);
    }
    // Honest, asserted scope line: ws is NOT closed by this layer and MUST still
    // reach the server even with enforcement armed. If a future change silently
    // starts (or claims to start) blocking ws, this catches the drift so the
    // copy and the code stay in agreement.
    if (receiptsFor(`/${phase}/ws`).length > 0) {
      ok(`${phase}: WebSocket remains the documented-open vector (reached server)`);
    } else {
      bad(`${phase}: WebSocket remains the documented-open vector`, 'ws did NOT arrive — scope/claim drift, reconcile the docs');
    }
  } else {
    const missing = ALL_VECTORS.filter((v) => receiptsFor(`/${phase}/${v}`).length === 0);
    if (missing.length === 0) {
      ok(`${phase}: all vectors pass through (fail-open)`, `receipts for ${ALL_VECTORS.join(', ')}`);
    } else {
      bad(`${phase}: all vectors pass through (fail-open)`, `never arrived: ${missing.join(', ')} (battery vacuous or wrongly blocked)`);
    }
  }
  if (receiptsFor(`/${phase}/control-post`).length > 0) {
    ok(`${phase}: allowed-origin control request passed`);
  } else {
    bad(`${phase}: allowed-origin control request passed`, 'control POST never reached the server');
  }
  note(`${phase} in-page outcomes: ${JSON.stringify(inPage)}`);
}

async function blockedEventCount() {
  return sw.evaluate(async () => {
    const s = await chrome.storage.local.get('sessions');
    let n = 0;
    for (const sess of s.sessions ?? []) {
      for (const e of sess.events ?? []) {
        const isBlock = e.type === 'action-blocked' || e.metadata?.outcome === 'blocked';
        if (isBlock && JSON.stringify(e).includes('blocked.test')) n++;
      }
    }
    return n;
  });
}

// ═════════════════════════════════════════════════════════════════════════════
try {
  extId = await launch();
  note(`extension ${extId}, fixture server :${port}, artifacts ${scratch}`);

  // ── fresh profile: the setting must be off before anyone touches it ────────
  const fresh = await swStorage(['settings']);
  if (!fresh.settings?.cdpEnforcementEnabled) {
    ok('default-off: fresh profile has cdpEnforcementEnabled unset/false');
  } else {
    bad('default-off: fresh profile has cdpEnforcementEnabled unset/false', JSON.stringify(fresh.settings));
  }

  // ── popup session 1: the REAL wizard authors allow + BLOCK patterns ────────
  const wizardResult = await popupDo(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const until = async (fn, ms = 6000) => {
      const t0 = Date.now();
      for (;;) {
        const v = fn();
        if (v) return v;
        if (Date.now() - t0 > ms) return null;
        await sleep(100);
      }
    };
    const btns = () => Array.from(document.querySelectorAll('#wizard-container button'));
    const byText = (t) => btns().find((b) => (b.textContent ?? '').trim().startsWith(t));
    const wizardBtn = await until(() => document.getElementById('delegation-wizard-btn'));
    if (!wizardBtn) return 'no-wizard-btn';
    wizardBtn.click();
    const limitedCard = await until(() => document.querySelectorAll('#wizard-container .preset-card')[1]);
    if (!limitedCard) return 'no-preset-cards';
    limitedCard.click(); // Limited Access -> sites step (synchronous render)
    const addPattern = (pattern, action) => {
      const input = document.querySelector('#wizard-container input.form-input');
      const select = document.getElementById('wizard-site-action');
      const add = byText('Add');
      if (!input || !select || !add) return false;
      input.value = pattern;
      select.value = action;
      add.click();
      return true;
    };
    if (!addPattern('allowed.test', 'allow')) return 'no-sites-ui';
    if (!addPattern('blocked.test', 'block')) return 'no-sites-ui-block';
    const next = byText('Next');
    if (!next) return 'no-next';
    next.click();
    const t15 = byText('15 minutes');
    if (!t15) return 'no-time-step';
    t15.click();
    const activate = byText('Activate Delegation');
    if (!activate) return 'no-activate';
    activate.click();
    return 'ok';
  });
  if (wizardResult !== 'ok') {
    bad('wizard: walked Limited preset with allow + block patterns', wizardResult);
  }
  let rule = null;
  for (let i = 0; i < 10 && !rule; i++) {
    const s = await swStorage(['delegationRules']);
    rule = (s.delegationRules ?? []).find((r) => r.isActive);
    if (!rule) await wait(400);
  }
  const hasBlock = rule?.scope?.sitePatterns?.some((p) => p.pattern === 'blocked.test' && p.action === 'block');
  const hasAllow = rule?.scope?.sitePatterns?.some((p) => p.pattern === 'allowed.test' && p.action === 'allow');
  if (rule && hasBlock && hasAllow) {
    ok('wizard: persisted ACTIVE rule with allow + BLOCK patterns', `preset=${rule.preset}`);
  } else {
    bad('wizard: persisted ACTIVE rule with allow + BLOCK patterns', JSON.stringify(rule?.scope?.sitePatterns));
  }

  // ── agent tab ──────────────────────────────────────────────────────────────
  let page = await openFixtureTab();
  await sprayUntilAgent(page, 'setup');

  // ── PHASE A: default-off — everything passes, and the battery is proven live
  const inPageA = await runBattery(page, 'phaseA');
  assertBattery('phaseA', inPageA, false);
  const eventsAfterA = await blockedEventCount();
  if (eventsAfterA === 0) {
    ok('phaseA: no CDP-block events in the session timeline (nothing was enforced)');
  } else {
    bad('phaseA: no CDP-block events in the session timeline', `${eventsAfterA} event(s) — enforcement ran while OFF`);
  }

  // ── popup session 2: enable via the real settings toggle ───────────────────
  const toggleOn = await popupDo(async (desired) => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const until = async (fn, ms = 6000) => {
      const t0 = Date.now();
      for (;;) {
        const v = fn();
        if (v) return v;
        if (Date.now() - t0 > ms) return null;
        await sleep(100);
      }
    };
    const settingsBtn = await until(() => document.getElementById('settings-btn'));
    if (!settingsBtn) return 'no-settings-btn';
    const findToggle = () => {
      for (const row of document.querySelectorAll('.settings-row')) {
        if (row.querySelector('.settings-label')?.textContent === 'Browser-layer blocking (advanced)') {
          return row.querySelector('input[type="checkbox"]');
        }
      }
      return null;
    };
    if (!findToggle()) settingsBtn.click();
    const box = await until(findToggle);
    if (!box) return 'no-cdp-toggle';
    if (box.checked !== desired) box.click();
    return 'ok';
  }, true);
  if (toggleOn !== 'ok') bad('settings: enabled browser-layer blocking via the real popup', toggleOn);
  let enabled = false;
  for (let i = 0; i < 10 && !enabled; i++) {
    const s = await swStorage(['settings']);
    enabled = s.settings?.cdpEnforcementEnabled === true;
    if (!enabled) await wait(400);
  }
  if (enabled) ok('settings: cdpEnforcementEnabled persisted true');
  else bad('settings: cdpEnforcementEnabled persisted true');
  await wait(2000); // SETTINGS_UPDATE reconcile -> attach

  // banner screenshot for the release notes (macOS, best effort, non-gating)
  if (platform() === 'darwin') {
    await page.bringToFront();
    await wait(400);
    await new Promise((r) => execFile('screencapture', ['-x', join(scratch, 'cdp-banner-attached.png')], () => r()));
    note(`banner screenshot -> ${join(scratch, 'cdp-banner-attached.png')}`);
  }

  // ── PHASE B: enforcement — the unwrapped vectors can ONLY be blocked here ──
  const inPageB = await runBattery(page, 'phaseB');
  assertBattery('phaseB', inPageB, true);
  const eventsAfterB = await blockedEventCount();
  if (eventsAfterB > 0) {
    ok('phaseB: CDP blocks recorded in the session timeline', `${eventsAfterB} event(s)`);
  } else {
    bad('phaseB: CDP blocks recorded in the session timeline', 'requests were blocked but nothing was reported');
  }

  // per-tab scope: the same blocked URL loads fine in a NON-delegated tab
  const other = await browser.newPage();
  let otherLoaded = false;
  try {
    const resp = await other.goto(`${BLOCKED}/phaseB-othertab`, { waitUntil: 'domcontentloaded', timeout: 8000 });
    otherLoaded = !!resp && resp.status() === 200;
  } catch { /* left false */ }
  if (otherLoaded && receiptsFor('/phaseB-othertab').length > 0) {
    ok('phaseB: blocked.test still loads in a non-delegated tab (per-tab scope)');
  } else {
    bad('phaseB: blocked.test still loads in a non-delegated tab (per-tab scope)', 'user browsing was affected');
  }
  await other.close().catch(() => {});

  // navigation to the blocked domain fails in the DELEGATED tab (tab-wide block)
  let navBlocked = false;
  try {
    await page.goto(`${BLOCKED}/phaseB-nav`, { waitUntil: 'domcontentloaded', timeout: 8000 });
  } catch (e) {
    navBlocked = String(e).includes('ERR_BLOCKED_BY_CLIENT') || String(e).includes('net::');
  }
  if (navBlocked && receiptsFor('/phaseB-nav').length === 0) {
    ok('phaseB: navigation to blocked.test blocked in the delegated tab');
  } else {
    bad('phaseB: navigation to blocked.test blocked in the delegated tab',
      `navBlocked=${navBlocked} receipts=${receiptsFor('/phaseB-nav').length}`);
  }
  // recover the fixture + agent for phase C
  await page.goto(`${ALLOWED}/`, { waitUntil: 'domcontentloaded' });
  await sprayUntilAgent(page, 'phaseB-recover');
  await wait(1500);

  // ── PHASE C1: setting off -> fail-open; back on -> re-attach ───────────────
  const toggleOff = await popupDo(async (desired) => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const until = async (fn, ms = 6000) => {
      const t0 = Date.now();
      for (;;) {
        const v = fn();
        if (v) return v;
        if (Date.now() - t0 > ms) return null;
        await sleep(100);
      }
    };
    const settingsBtn = await until(() => document.getElementById('settings-btn'));
    if (!settingsBtn) return 'no-settings-btn';
    const findToggle = () => {
      for (const row of document.querySelectorAll('.settings-row')) {
        if (row.querySelector('.settings-label')?.textContent === 'Browser-layer blocking (advanced)') {
          return row.querySelector('input[type="checkbox"]');
        }
      }
      return null;
    };
    if (!findToggle()) settingsBtn.click();
    const box = await until(findToggle);
    if (!box) return 'no-cdp-toggle';
    if (box.checked !== desired) box.click();
    return 'ok';
  }, false);
  if (toggleOff !== 'ok') bad('phaseC1: disabled the setting via the popup', toggleOff);
  await wait(1500);
  const inPageC1off = await runBattery(page, 'phaseC1off');
  assertBattery('phaseC1off', inPageC1off, false);

  const toggleOn2 = await popupDo(async (desired) => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const until = async (fn, ms = 6000) => {
      const t0 = Date.now();
      for (;;) {
        const v = fn();
        if (v) return v;
        if (Date.now() - t0 > ms) return null;
        await sleep(100);
      }
    };
    const settingsBtn = await until(() => document.getElementById('settings-btn'));
    if (!settingsBtn) return 'no-settings-btn';
    const findToggle = () => {
      for (const row of document.querySelectorAll('.settings-row')) {
        if (row.querySelector('.settings-label')?.textContent === 'Browser-layer blocking (advanced)') {
          return row.querySelector('input[type="checkbox"]');
        }
      }
      return null;
    };
    if (!findToggle()) settingsBtn.click();
    const box = await until(findToggle);
    if (!box) return 'no-cdp-toggle';
    if (box.checked !== desired) box.click();
    return 'ok';
  }, true);
  if (toggleOn2 !== 'ok') bad('phaseC1: re-enabled the setting via the popup', toggleOn2);
  await wait(2000);
  const inPageC1on = await runBattery(page, 'phaseC1on');
  assertBattery('phaseC1on', inPageC1on, true);

  // ── PHASE C2: tab close -> a fresh agent tab still attaches ────────────────
  await page.close().catch(() => {});
  await wait(800);
  page = await openFixtureTab();
  await sprayUntilAgent(page, 'phaseC2');
  await wait(1500);
  const inPageC2 = await runBattery(page, 'phaseC2');
  assertBattery('phaseC2', inPageC2, true);

  // ── PHASE C3: delegation expiry (storage rewrite + restart) -> no attach ───
  await sw.evaluate(async () => {
    const s = await chrome.storage.local.get('delegationRules');
    const rules = (s.delegationRules ?? []).map((r) => r.isActive ? {
      ...r,
      scope: {
        ...r.scope,
        timeBound: {
          durationMinutes: 15,
          grantedAt: new Date(Date.now() - 2 * 3600_000).toISOString(),
          expiresAt: new Date(Date.now() - 1 * 3600_000).toISOString(),
        },
      },
    } : r);
    await chrome.storage.local.set({ delegationRules: rules });
  });
  await relaunch();
  page = await openFixtureTab();
  await sprayUntilAgent(page, 'phaseExp');
  await wait(2000);
  const inPageExp = await runBattery(page, 'phaseExp');
  assertBattery('phaseExp', inPageExp, false); // expired rule: no attach, fail-open

  // ── PHASE C4: restart with a VALID rule -> self-heal re-attach ─────────────
  await sw.evaluate(async () => {
    const s = await chrome.storage.local.get('delegationRules');
    const rules = (s.delegationRules ?? []).map((r) => r.isActive ? {
      ...r,
      scope: {
        ...r.scope,
        timeBound: {
          durationMinutes: 15,
          grantedAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(),
        },
      },
    } : r);
    await chrome.storage.local.set({ delegationRules: rules });
  });
  await relaunch();
  page = await openFixtureTab();
  await sprayUntilAgent(page, 'phaseHeal');
  await wait(2500);
  const inPageHeal = await runBattery(page, 'phaseHeal');
  assertBattery('phaseHeal', inPageHeal, true); // restart + reconcile re-attached

  // ── PHASE C5: kill switch -> total teardown, user browsing unaffected ──────
  const killResult = await popupDo(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const until = async (fn, ms = 8000) => {
      const t0 = Date.now();
      for (;;) {
        const v = fn();
        if (v) return v;
        if (Date.now() - t0 > ms) return null;
        await sleep(150);
      }
    };
    const btn = await until(() => {
      const b = document.getElementById('kill-switch-btn');
      return b && !b.disabled ? b : null;
    });
    if (!btn) return 'kill-switch-btn-never-enabled';
    btn.click();
    return 'ok';
  });
  if (killResult !== 'ok') bad('phaseKill: kill switch clicked in the popup', killResult);
  let killed = false;
  for (let i = 0; i < 12 && !killed; i++) {
    const s = await swStorage(['killSwitchState']);
    killed = s.killSwitchState?.isActive === true;
    if (!killed) await wait(500);
  }
  if (killed) ok('phaseKill: kill switch latched (killSwitchState.isActive)');
  else bad('phaseKill: kill switch latched (killSwitchState.isActive)');
  await wait(1000);
  const free = await browser.newPage();
  let freeLoaded = false;
  try {
    const resp = await free.goto(`${BLOCKED}/phaseKill-free`, { waitUntil: 'domcontentloaded', timeout: 8000 });
    freeLoaded = !!resp && resp.status() === 200;
  } catch { /* left false */ }
  if (freeLoaded && receiptsFor('/phaseKill-free').length > 0) {
    ok('phaseKill: after kill switch nothing stays attached or blocked (browsing free)');
  } else {
    bad('phaseKill: after kill switch nothing stays attached or blocked (browsing free)',
      `loaded=${freeLoaded} receipts=${receiptsFor('/phaseKill-free').length}`);
  }
} catch (err) {
  bad('cdp smoke aborted', String(err).slice(0, 300));
} finally {
  if (browser) await browser.close().catch(() => {});
  server.close();
}

const failures = results.filter(([p]) => !p).length;
console.log(failures ? `\nCDP SMOKE FAIL (${failures} failure(s) / ${results.length} checks)` : `\nCDP SMOKE ALL GREEN (${results.length} checks)`);
process.exit(failures ? 1 : 0);
