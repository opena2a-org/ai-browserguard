/**
 * Live smoke (#69): the user's download in a tab where they have DevTools
 * open, with a session delegation set to Read-Only and Browser-layer blocking
 * on. No automation client touches any page.
 *
 * An open DevTools window makes the page it inspects report an attachment in
 * chrome.debugger.getTargets, exactly as an external CDP client would. The
 * extension's periodic attachment check registers that tab as an agent at
 * `medium` confidence, and Browser-layer blocking then attaches its session
 * there, which reports the downloads started in that tab. Before this smoke
 * existed, that report was taken as the agent's: the user's own download in
 * the tab they were inspecting was cancelled (USER_CANCELED) and counted as a
 * blocked action.
 *
 * The browser is started with --auto-open-devtools-for-tabs, which opens the
 * same DevTools front end F12 opens, docked to every tab. The smoke does not
 * press F12. It checks:
 *   - the measurement the rest depends on: the inspected page reports
 *     attached:true and a devtools:// front end is listed, read through the
 *     extension's own chrome.debugger.getTargets
 *   - the tab is registered from the attachment at `medium` confidence, so the
 *     path that cancelled before is exercised
 *   - a download started in that tab completes, the file is saved, it is
 *     recorded as a host match (never as started in the agent's tab) and it
 *     is not counted as a blocked action
 *
 * The browser has a window, no --enable-automation and
 * --disable-blink-features=AutomationControlled, as in smoke-downloads.mjs, so
 * the page detector does not report every tab. Run: npm run build && npm run
 * smoke:devtools (opens a browser window; needs a display; about 30 s).
 * CHROME_PATH selects the browser; the default is the one Puppeteer installed.
 * Exit 0 pass, 1 fail, 2 watchdog.
 */
import puppeteer from 'puppeteer';
import { createServer } from 'node:http';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dist = resolve(root, 'dist');
if (!existsSync(join(dist, 'manifest.json'))) {
  console.error('dist/manifest.json not found. Run `npm run build` first.');
  process.exit(1);
}

const results = [];
const ok = (n, d = '') => { results.push([true, n]); console.log(`  PASS  ${n}${d ? ' -- ' + d : ''}`); };
const bad = (n, d = '') => { results.push([false, n]); console.log(`  FAIL  ${n}${d ? ' -- ' + d : ''}`); };
const check = (n, cond, d = '') => (cond ? ok(n, d) : bad(n, d));
const note = (m) => console.log(`  note: ${m}`);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
setTimeout(() => { console.log('\nWATCHDOG: 180s elapsed, aborting'); process.exit(2); }, 180_000).unref();

// The Read-Only preset's capabilities, read from source as smoke-downloads does.
const rulesSrc = readFileSync(join(root, 'src/delegation/rules.ts'), 'utf8');
function capabilityList(name) {
  const m = rulesSrc.match(new RegExp(`const ${name}: AgentCapability\\[\\] = \\[([\\s\\S]*?)\\];`));
  if (!m) throw new Error(`could not read ${name} from src/delegation/rules.ts`);
  return [...m[1].matchAll(/'([a-z-]+)'/g)].map((x) => x[1]);
}
const READ_ONLY = capabilityList('READ_ONLY_CAPABILITIES');
const ALL = capabilityList('ALL_CAPABILITIES');
const schemaSrc = readFileSync(join(root, 'src/session/types.ts'), 'utf8');
const SCHEMA_VERSION = Number(/CURRENT_STORAGE_SCHEMA_VERSION = (\d+)/.exec(schemaSrc)?.[1]);

const readOnlyRule = {
  id: 'smoke-devtools-read-only',
  preset: 'readOnly',
  scope: {
    // One block pattern, so Browser-layer blocking attaches to agent tabs.
    sitePatterns: [{ pattern: 'blocked.localhost', action: 'block' }],
    actionRestrictions: ALL.map((c) => ({ capability: c, action: READ_ONLY.includes(c) ? 'allow' : 'block' })),
    timeBound: null,
  },
  createdAt: new Date().toISOString(),
  agentId: null,
  isActive: true,
};

// ── fixture server ───────────────────────────────────────────────────────────
const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://fixture');
  const file = /^\/files\/([a-z0-9-]+\.csv)$/.exec(url.pathname);
  if (url.pathname === '/reports') {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<!doctype html><title>reports</title><p>The user inspects this page with DevTools.</p>');
  } else if (file) {
    res.writeHead(200, { 'content-type': 'text/csv', 'content-disposition': `attachment; filename="${file[1]}"` });
    res.end('a'.repeat(64 * 1024));
  } else {
    res.writeHead(404);
    res.end();
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const SITE = `http://site.localhost:${server.address().port}`;

// ── browser ──────────────────────────────────────────────────────────────────
const work = mkdtempSync(join(tmpdir(), 'abg-devtools-smoke-'));
const profile = join(work, 'profile');
const saved = join(work, 'saved');
mkdirSync(join(profile, 'Default'), { recursive: true });
mkdirSync(saved);
writeFileSync(join(profile, 'Default', 'Preferences'), JSON.stringify({
  download: { default_directory: saved, prompt_for_download: false, directory_upgrade: true },
}));

const launchOptions = {
  headless: false,
  ignoreDefaultArgs: ['--enable-automation'],
  pipe: true,
  enableExtensions: [dist],
  userDataDir: profile,
  waitForInitialPage: false,
  protocolTimeout: 30_000,
  // The harness attaches to the extension's worker only: no page, tab or
  // DevTools front end, so the only client on the user's page is DevTools.
  targetFilter: (t) => t.type() === 'service_worker' || t.type() === 'browser',
  args: [
    '--remote-debugging-pipe',
    '--auto-open-devtools-for-tabs',
    '--disable-blink-features=AutomationControlled',
    '--no-first-run', '--no-default-browser-check',
  ],
};
if (process.env.CHROME_PATH) launchOptions.executablePath = process.env.CHROME_PATH;

const browser = await puppeteer.launch(launchOptions);
let worker = null;
const usedWorkerTargets = new Set();
const within = (ms, promise) => Promise.race([promise, wait(ms).then(() => { throw new Error(`no answer in ${ms} ms`); })]);

async function attachWorker() {
  const target = await browser.waitForTarget(
    (t) => t.type() === 'service_worker' && t.url().startsWith('chrome-extension://') && !usedWorkerTargets.has(t),
    { timeout: 20_000 },
  );
  usedWorkerTargets.add(target);
  worker = await within(10_000, target.worker());
  for (let i = 0; i < 40; i++) {
    const ready = await within(2_000, worker.evaluate(() =>
      typeof chrome !== 'undefined' && !!chrome.storage?.local && !!chrome.downloads && !!chrome.debugger,
    )).catch(() => false);
    if (ready) return;
    await wait(250);
  }
  throw new Error('extension worker never became ready');
}

const targetsOf = () => worker.evaluate(() => new Promise((r) => chrome.debugger.getTargets((ts) =>
  r(ts.map((t) => ({ type: t.type, url: t.url, attached: t.attached, tabId: t.tabId }))))));

const registered = (tabId) => worker.evaluate(async (id) => {
  const s = await chrome.storage.local.get('activeAgentRegistry');
  const e = s.activeAgentRegistry?.[String(id)];
  return e ? { confidence: e.agent?.confidence ?? null, fromDebugger: e.fromDebugger === true } : null;
}, tabId);

const blockedTotal = () => worker.evaluate(async () => {
  const s = await chrome.storage.local.get('lifetimeStats');
  return s.lifetimeStats?.totalActionsBlocked ?? 0;
});

// ═════════════════════════════════════════════════════════════════════════════
try {
  await attachWorker();
  note(`browser ${await browser.version()}, downloads to ${saved}`);
  await worker.evaluate(async (rule, version) => {
    const { settings } = await chrome.storage.local.get('settings');
    await chrome.storage.local.set({
      storageSchemaVersion: version,
      delegationRules: [rule],
      settings: { ...(settings ?? {}), cdpEnforcementEnabled: true },
    });
    setTimeout(() => chrome.runtime.reload(), 50);
  }, readOnlyRule, SCHEMA_VERSION);
  await attachWorker();
  const stored = await worker.evaluate(() => chrome.storage.local.get(['settings', 'delegationRules']));
  check(
    'armed: Read-Only session delegation, Browser-layer blocking on',
    stored.settings?.cdpEnforcementEnabled === true && stored.delegationRules?.[0]?.isActive === true,
  );

  const pageUrl = `${SITE}/reports`;
  const tabId = await worker.evaluate(async (u) => (await chrome.tabs.create({ url: u, active: true })).id, pageUrl);

  // The measurement: what an open DevTools window looks like to the extension.
  let inspected = null;
  let frontEnd = false;
  for (let i = 0; i < 40 && !(inspected?.attached && frontEnd); i++) {
    await wait(250);
    const ts = await targetsOf();
    inspected = ts.find((t) => t.tabId === tabId && t.type === 'page') ?? null;
    frontEnd = ts.some((t) => t.url.startsWith('devtools://'));
  }
  check('DevTools open: the inspected page reports attached:true', inspected?.attached === true, JSON.stringify(inspected));
  check('DevTools open: a devtools:// front end is listed', frontEnd);

  // The periodic check (every 3 s) registers the inspected tab from the attachment.
  let entry = null;
  for (let i = 0; i < 40 && !entry; i++) { await wait(250); entry = await registered(tabId); }
  check(
    "the inspected tab is registered from the attachment at medium confidence",
    entry?.fromDebugger === true && entry.confidence === 'medium',
    JSON.stringify(entry),
  );
  // Give Browser-layer blocking time to attach its session to that tab.
  await wait(3000);

  const before = await blockedTotal();
  const name = 'inspected-tab.csv';
  const fileUrl = `${SITE}/files/${name}`;
  await worker.evaluate((id, u) => chrome.tabs.update(id, { url: u }), tabId, fileUrl);
  let end = null;
  for (let i = 0; i < 60; i++) {
    end = await worker.evaluate((u) => new Promise((r) => chrome.downloads.search({ url: u }, (items) => {
      const d = items?.[0];
      r(d ? { state: d.state, error: d.error ?? null } : null);
    })), fileUrl);
    if (end && end.state !== 'in_progress') break;
    await wait(250);
  }
  check('download in the inspected tab: completed', end?.state === 'complete', JSON.stringify(end));
  check('download in the inspected tab: file saved', readdirSync(saved).includes(name));

  let attribution = null;
  for (let i = 0; i < 20 && !attribution; i++) {
    attribution = await worker.evaluate(async (u) => {
      const { sessions } = await chrome.storage.local.get('sessions');
      for (const s of sessions ?? []) {
        for (const e of s.events ?? []) if (e.type === 'download' && e.url === u) return e.attribution ?? { level: 'missing' };
      }
      return null;
    }, fileUrl);
    if (!attribution) await wait(250);
  }
  check(
    'download in the inspected tab: recorded as a host match, not as started in the agent tab',
    attribution?.level === 'host',
    JSON.stringify(attribution),
  );
  const after = await blockedTotal();
  check('download in the inspected tab: not counted as a blocked action', after === before, `${before} -> ${after}`);
} catch (err) {
  bad('smoke ran to the end', err instanceof Error ? err.message : String(err));
} finally {
  await browser.close().catch(() => {});
  server.close();
  rmSync(work, { recursive: true, force: true });
}

const failed = results.filter(([pass]) => !pass);
console.log(`\n${results.length - failed.length} passed, ${failed.length} failed`);
process.exit(failed.length ? 1 : 0);
