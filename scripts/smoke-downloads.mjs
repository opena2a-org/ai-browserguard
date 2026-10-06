/**
 * Live download smoke (#69): the built extension in a real browser, a session
 * delegation set to Read-Only, and an external CDP client attached to one tab.
 * The user's own downloads in other tabs must complete; a download started in
 * the agent's tab is cancelled only while Browser-layer blocking holds a
 * debugger session on that tab.
 *
 * Ground truth is the browser's own download record (chrome.downloads state
 * and error), the file on disk, the persisted blocked-action counter and the
 * `attribution` level on the download event in the agent's stored session.
 *
 * Setup: a local server answers as site.localhost (the agent's site) and
 * other.localhost (another site). The harness itself attaches to no page or
 * tab; the only debugger client on a page is a raw CDP client (the driver)
 * attached to the agent's tab, as an external automation tool would be. The
 * extension registers that tab as an agent from the attachment, and the smoke
 * checks that no other signal registers an agent. The page detector reports
 * every tab of a headless browser, and every tab where navigator.webdriver is
 * true, which --enable-automation and --remote-debugging-pipe both set; the
 * browser in #69 was started with a debugging port and showed neither. So
 * this browser has a window, no --enable-automation, and
 * --disable-blink-features=AutomationControlled for the pipe. The session
 * delegation is Read-Only (downloads blocked) with one site block pattern, so
 * Browser-layer blocking has a rule to enforce and attaches when it is on.
 *
 * Each phase runs three downloads, each a 256 KB file served over about 2 s:
 *   other site   the user's tab on other.localhost        complete, attribution none
 *   same host    the user's tab on site.localhost, no agent  complete, attribution host
 *   agent tab    the driver navigates the agent's tab to a file
 * Phase A, Browser-layer blocking off (the configuration in #69): the agent-tab
 * download completes too (attribution host), nothing is counted as blocked.
 * Phase B, Browser-layer blocking on: the agent-tab download is cancelled
 * (USER_CANCELED, no file, attribution tab, blocked counter +1); the two user
 * downloads still complete and are not counted.
 *
 * Settings and the delegation are written to chrome.storage and the extension
 * is reloaded so the background loads them, which needs no popup and no OS
 * focus. Run: npm run build && npm run smoke:downloads   (opens a browser
 * window; needs a display; about 1 minute). CHROME_PATH selects the browser;
 * the default is the one Puppeteer installed. Exit 0 pass, 1 fail, 2 watchdog.
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
setTimeout(() => { console.log('\nWATCHDOG: 300s elapsed, aborting'); process.exit(2); }, 300_000).unref();

// Read the Read-Only preset's capabilities from source so this smoke builds the
// same rule the wizard does.
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
  id: 'smoke-downloads-read-only',
  preset: 'readOnly',
  scope: {
    // One block pattern: Browser-layer blocking attaches only to a tab whose
    // rule has something to enforce at that layer.
    sitePatterns: [{ pattern: 'blocked.localhost', action: 'block' }],
    actionRestrictions: ALL.map((c) => ({ capability: c, action: READ_ONLY.includes(c) ? 'allow' : 'block' })),
    timeBound: null,
  },
  createdAt: new Date().toISOString(),
  agentId: null,
  isActive: true,
};

// ── fixture server ───────────────────────────────────────────────────────────
const FILE_SIZE = 256 * 1024;
const CHUNK = 16 * 1024;
const PACE_MS = 125;
const served = [];
const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://fixture');
  const file = /^\/files\/([a-z0-9-]+\.csv)$/.exec(url.pathname);
  const user = /^\/user\/([a-z0-9-]+\.csv)$/.exec(url.pathname);
  if (url.pathname === '/agent') {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<!doctype html><title>agent page</title><p>Page an automation client drives.</p>');
  } else if (user) {
    // The user's page starts its own download; no debugger client touches it.
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(`<!doctype html><title>user page</title><meta http-equiv="refresh" content="0;url=/files/${user[1]}">`);
  } else if (file) {
    served.push(`${req.headers.host}${url.pathname}`);
    res.writeHead(200, {
      'content-type': 'text/csv',
      'content-disposition': `attachment; filename="${file[1]}"`,
      'content-length': String(FILE_SIZE),
    });
    const body = Buffer.alloc(CHUNK, 0x61);
    let sent = 0;
    const tick = () => {
      if (res.destroyed) return;
      if (sent >= FILE_SIZE) { res.end(); return; }
      res.write(body);
      sent += CHUNK;
      setTimeout(tick, PACE_MS);
    };
    tick();
  } else {
    res.writeHead(404);
    res.end();
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
// *.localhost resolves to loopback and is a secure origin, so Chrome does not
// hold these downloads as insecure.
const SITE = `http://site.localhost:${port}`;
const OTHER = `http://other.localhost:${port}`;

// ── browser ──────────────────────────────────────────────────────────────────
const work = mkdtempSync(join(tmpdir(), 'abg-dl-smoke-'));
const profile = join(work, 'profile');
const saved = join(work, 'saved');
mkdirSync(join(profile, 'Default'), { recursive: true });
mkdirSync(saved);
writeFileSync(join(profile, 'Default', 'Preferences'), JSON.stringify({
  download: { default_directory: saved, prompt_for_download: false, directory_upgrade: true },
}));

const launchOptions = {
  // A window, no --enable-automation and no navigator.webdriver (see the
  // header): otherwise the page detector reports every tab as an agent.
  headless: false,
  ignoreDefaultArgs: ['--enable-automation'],
  pipe: true,
  enableExtensions: [dist],
  userDataDir: profile,
  waitForInitialPage: false,
  protocolTimeout: 30_000,
  // The harness attaches to the extension's worker only. Tabs and pages are
  // left alone so the one debugger client on a page is the driver below.
  targetFilter: (t) => t.type() !== 'page' && t.type() !== 'tab',
  // A port as well as the pipe, so the driver can connect as a second client.
  // Puppeteer adds no transport flag once one is given, so both are named.
  args: [
    '--remote-debugging-pipe', '--remote-debugging-port=0',
    '--disable-blink-features=AutomationControlled',
    '--no-first-run', '--no-default-browser-check',
  ],
};
if (process.env.CHROME_PATH) launchOptions.executablePath = process.env.CHROME_PATH;

const browser = await puppeteer.launch(launchOptions);
let worker = null;
/** Worker targets already used. A reload leaves the old one listed, and it never answers. */
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
      typeof chrome !== 'undefined' && !!chrome.storage?.local && !!chrome.downloads && !!chrome.tabs,
    )).catch(() => false);
    if (ready) return;
    await wait(250);
  }
  throw new Error('extension worker never became ready');
}

/** Write the delegation and the Browser-layer blocking setting, then reload the extension so its background loads them. */
async function armAndReload(blocking) {
  await worker.evaluate(async (rule, on, version) => {
    const { settings } = await chrome.storage.local.get('settings');
    await chrome.storage.local.set({
      storageSchemaVersion: version,
      delegationRules: [rule],
      settings: { ...(settings ?? {}), cdpEnforcementEnabled: on },
    });
    setTimeout(() => chrome.runtime.reload(), 50);
  }, readOnlyRule, blocking, SCHEMA_VERSION);
  await attachWorker();
  const stored = await worker.evaluate(() => chrome.storage.local.get(['settings', 'delegationRules']));
  check(
    `armed: Read-Only session delegation, Browser-layer blocking ${blocking ? 'on' : 'off'}`,
    stored.settings?.cdpEnforcementEnabled === blocking &&
      stored.delegationRules?.length === 1 && stored.delegationRules[0].isActive === true,
  );
}

// ── the driver: a raw CDP client attached to the agent's tab only ────────────
async function connectDriver() {
  const portFile = join(profile, 'DevToolsActivePort');
  for (let i = 0; i < 40 && !existsSync(portFile); i++) await wait(250);
  const [debugPort, path] = readFileSync(portFile, 'utf8').trim().split('\n');
  const ws = new WebSocket(`ws://127.0.0.1:${debugPort}${path}`);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = () => j(new Error('driver could not connect')); });
  let nextId = 0;
  const pending = new Map();
  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data);
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    if (msg.error) p.reject(new Error(msg.error.message)); else p.resolve(msg.result);
  };
  const send = (method, params = {}, sessionId) => new Promise((r, j) => {
    const id = ++nextId;
    pending.set(id, { resolve: r, reject: j });
    ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
  return { send, close: () => ws.close() };
}

// ── observations ─────────────────────────────────────────────────────────────
/** Registered agents as [tabId, registered from a debugger attachment]. */
const registry = () => worker.evaluate(async () => {
  const s = await chrome.storage.local.get('activeAgentRegistry');
  return Object.entries(s.activeAgentRegistry ?? {}).map(([tab, e]) => [Number(tab), e?.fromDebugger === true]);
});
const onlyAgentIs = (entries, tabId) => entries.length === 1 && entries[0][0] === tabId && entries[0][1];

async function waitForOnlyAgent(tabId, label) {
  let entries = [];
  for (let i = 0; i < 40; i++) {
    entries = await registry();
    if (onlyAgentIs(entries, tabId)) { ok(label, `agent registered from the attachment on tab ${tabId} only`); return true; }
    await wait(500);
  }
  bad(label, `registry ${JSON.stringify(entries)}, expected [[${tabId}, true]]`);
  return false;
}

const blockedTotal = () => worker.evaluate(async () => {
  const s = await chrome.storage.local.get('lifetimeStats');
  return s.lifetimeStats?.totalActionsBlocked ?? 0;
});

/**
 * The browser's record of the download whose final URL is `fileUrl`, once it
 * has ended (or null on timeout). A page that refreshes into a file is
 * recorded with the page as `url` and the file as `finalUrl`.
 */
async function downloadEnd(fileUrl) {
  for (let i = 0; i < 60; i++) {
    const item = await worker.evaluate((u) => new Promise((r) => chrome.downloads.search({ finalUrl: u }, (items) => {
      const d = items?.[0];
      r(d ? { state: d.state, error: d.error ?? null, url: d.url, finalUrl: d.finalUrl } : null);
    })), fileUrl);
    if (item && item.state !== 'in_progress') return item;
    await wait(250);
  }
  return null;
}

/** The attribution level on the stored download event for the item `end`, or null. */
async function attributionOf(end) {
  const urls = [end?.url, end?.finalUrl].filter(Boolean);
  for (let i = 0; i < 20; i++) {
    const level = await worker.evaluate(async (us) => {
      const { sessions } = await chrome.storage.local.get('sessions');
      for (const s of sessions ?? []) {
        for (const e of s.events ?? []) {
          if (e.type === 'download' && us.includes(e.url)) return e.attribution?.level ?? 'missing';
        }
      }
      return null;
    }, urls);
    if (level) return level;
    await wait(250);
  }
  return null;
}

const savedFile = (name) => readdirSync(saved).includes(name);

async function userDownload(label, origin, name) {
  const tabId = await worker.evaluate(async (u) => (await chrome.tabs.create({ url: u, active: true })).id, `${origin}/user/${name}`);
  const end = await downloadEnd(`${origin}/files/${name}`);
  const entries = await registry();
  check(`${label}: the user's tab is not an agent`, onlyAgentIs(entries, agentTab), JSON.stringify(entries));
  await worker.evaluate((id) => chrome.tabs.remove(id).catch(() => {}), tabId);
  return end;
}

async function expectCompleted(label, end, name, level, blockedBefore) {
  check(`${label}: download completed`, end?.state === 'complete', JSON.stringify(end));
  check(`${label}: file saved`, savedFile(name));
  const got = await attributionOf(end);
  check(`${label}: recorded with attribution ${level}`, got === level, `got ${got}`);
  const after = await blockedTotal();
  check(`${label}: not counted as a blocked action`, after === blockedBefore, `${blockedBefore} -> ${after}`);
}

// ═════════════════════════════════════════════════════════════════════════════
let driver = null;
let agentTab = null;
try {
  await attachWorker();
  note(`fixture server :${port}, downloads to ${saved}`);
  await armAndReload(false);

  agentTab = await worker.evaluate(async (u) => (await chrome.tabs.create({ url: u, active: true })).id, `${SITE}/agent`);
  await wait(1000);
  driver = await connectDriver();
  const { targetInfos } = await driver.send('Target.getTargets');
  const agentTarget = targetInfos.find((t) => t.type === 'page' && t.url === `${SITE}/agent`);
  if (!agentTarget) throw new Error('agent page target not found');
  const { sessionId } = await driver.send('Target.attachToTarget', { targetId: agentTarget.targetId, flatten: true });
  note(`driver attached to the agent's tab ${agentTab}`);

  for (const [phase, blocking] of [['A', false], ['B', true]]) {
    console.log(`\n[${phase}] Read-Only, Browser-layer blocking ${blocking ? 'on' : 'off'}`);
    if (blocking) await armAndReload(true);
    // Recorded, not a reason to stop: the downloads below still show what
    // happens to each file.
    await waitForOnlyAgent(agentTab, `${phase}: external client's tab is the only agent`);
    // Give Browser-layer blocking time to attach its session after the reload.
    if (blocking) await wait(3000);
    const p = phase.toLowerCase();

    // The #69 scenario: the user's own download from another site in another tab.
    let before = await blockedTotal();
    let name = `${p}-other-site.csv`;
    await expectCompleted(`${phase} other site`, await userDownload(`${phase} other site`, OTHER, name), name, 'none', before);

    // The user's download from the agent's site in a tab with no agent.
    before = await blockedTotal();
    name = `${p}-same-host.csv`;
    await expectCompleted(`${phase} same host`, await userDownload(`${phase} same host`, SITE, name), name, 'host', before);

    // The agent's own download, started in its tab by the driver.
    before = await blockedTotal();
    name = `${p}-agent-tab.csv`;
    const url = `${SITE}/files/${name}`;
    await driver.send('Page.navigate', { url }, sessionId);
    const end = await downloadEnd(url);
    if (blocking) {
      check(`${phase} agent tab: download cancelled`, end?.state === 'interrupted' && end.error === 'USER_CANCELED', JSON.stringify(end));
      check(`${phase} agent tab: no file saved`, !savedFile(name));
      const got = await attributionOf(end);
      check(`${phase} agent tab: recorded with attribution tab`, got === 'tab', `got ${got}`);
      let after = before;
      for (let i = 0; i < 20 && after === before; i++) { await wait(250); after = await blockedTotal(); }
      check(`${phase} agent tab: counted as one blocked action`, after === before + 1, `${before} -> ${after}`);
    } else {
      await expectCompleted(`${phase} agent tab (no Browser-layer session)`, end, name, 'host', before);
    }
  }
  check('server sent every download it was asked for', served.length === 6, served.join(', '));
} catch (err) {
  bad('smoke ran to the end', err instanceof Error ? err.message : String(err));
} finally {
  driver?.close();
  await browser.close().catch(() => {});
  server.close();
  rmSync(work, { recursive: true, force: true });
}

const failed = results.filter(([pass]) => !pass);
console.log(`\n${results.length - failed.length} passed, ${failed.length} failed`);
process.exit(failed.length ? 1 : 0);
