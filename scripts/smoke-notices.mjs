/**
 * Live notice smoke: the in-page block notices an in-page agent's actions
 * leave on the page, in a real browser, under a session-wide Read-Only
 * delegation as the wizard builds it.
 *
 * The page is scripts/inpage-agent-fixture.html served over http. With the
 * fixture's spray running (synthetic mouse moves and clicks every 2 s, each
 * click blocked), the smoke repeats the fixture's violation steps [1] to [3]
 * from page script: a synthetic click on its link, a keydown and an input in
 * its field, a submit event on its form. Read-Only blocks all four events. The
 * notices stack three high, a new one drops the oldest, and a block identical
 * to the newest notice counts on it, so afterwards they read, oldest first:
 * "Blocked click. ×7" (the spray's six clicks and the link's), "Blocked text
 * input. ×2" (the keydown and the input), "Blocked form submission.". The last
 * offers no "Allow once" and is not dismissed on a timer, so it is the one
 * notice left once the other two time out. Ten more blocked clicks count on
 * one new notice below it, "Blocked click. ×10".
 *
 * Ground truth: the fixture's own handlers, which a blocked event never
 * reaches; the notices read from the page's DOM over the debugging protocol
 * (DOM.getDocument with pierce, since page script cannot open the closed
 * shadow root that holds them); and every exception and console call in the
 * content script's isolated world, which are printed with the step they
 * happened in.
 *
 * The extension is loaded over the debugging pipe (enableExtensions), which
 * Google Chrome honours where it ignores the command-line flag that loads an
 * unpacked extension. The delegation is written to chrome.storage and the
 * extension is reloaded so its background loads it; the profile has Developer mode on (smoke-profile.mjs) so the
 * reload leaves the extension enabled. Headless, so it needs no display and
 * no OS focus. Run: npm run build && npm run smoke:notices   (about 30 s).
 * CHROME_PATH selects the browser; the default is the one Puppeteer installed.
 * Exit 0 pass, 1 fail, 2 watchdog.
 */
import puppeteer from 'puppeteer';
import { enableDeveloperMode } from './smoke-profile.mjs';
import { createServer } from 'node:http';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
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
setTimeout(() => { console.log('\nWATCHDOG: 120s elapsed, aborting'); process.exit(2); }, 120_000).unref();

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
  id: 'smoke-notices-read-only',
  preset: 'readOnly',
  scope: {
    // No site patterns: the wizard offers no sites step for Read-Only.
    sitePatterns: [],
    actionRestrictions: ALL.map((c) => ({ capability: c, action: READ_ONLY.includes(c) ? 'allow' : 'block' })),
    timeBound: null,
  },
  createdAt: new Date().toISOString(),
  agentId: null,
  isActive: true,
};

// ── fixture server ───────────────────────────────────────────────────────────
const fixtureHtml = readFileSync(join(root, 'scripts/inpage-agent-fixture.html'), 'utf8');
const server = createServer((req, res) => {
  if (new URL(req.url, 'http://fixture').pathname === '/') {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(fixtureHtml);
  } else {
    res.writeHead(404);
    res.end();
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const fixtureUrl = `http://127.0.0.1:${server.address().port}/`;

// ── browser ──────────────────────────────────────────────────────────────────
const work = mkdtempSync(join(tmpdir(), 'abg-notices-smoke-'));
const profile = join(work, 'profile');
mkdirSync(profile, { recursive: true });

const launchOptions = {
  headless: true,
  pipe: true,
  enableExtensions: [dist],
  userDataDir: profile,
  protocolTimeout: 30_000,
  args: ['--no-first-run', '--no-default-browser-check'],
};
if (process.env.CHROME_PATH) launchOptions.executablePath = process.env.CHROME_PATH;

// Developer mode on, so the extension stays enabled when it is reloaded below.
await enableDeveloperMode(puppeteer, { userDataDir: profile, executablePath: process.env.CHROME_PATH });
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
      typeof chrome !== 'undefined' && !!chrome.storage?.local && !!chrome.tabs,
    )).catch(() => false);
    if (ready) return;
    await wait(250);
  }
  throw new Error('extension worker never became ready');
}

/** Write the delegation, then reload the extension so its background loads it. */
async function armAndReload() {
  await worker.evaluate(async (rule, version) => {
    await chrome.storage.local.set({ storageSchemaVersion: version, delegationRules: [rule] });
    setTimeout(() => chrome.runtime.reload(), 50);
  }, readOnlyRule, SCHEMA_VERSION);
  await attachWorker();
  const stored = await worker.evaluate(() => chrome.storage.local.get('delegationRules'));
  check(
    'armed: Read-Only session delegation',
    stored.delegationRules?.length === 1 && stored.delegationRules[0].isActive === true,
  );
}

// ── observations ─────────────────────────────────────────────────────────────
let cdp = null;
let step = 'load';
/** Execution contexts of the extension's content script (isolated world), id -> name. */
const isolated = new Map();
/** Exceptions and console calls in those contexts, with the step they happened in. */
const contentLog = [];

function watchContentScript() {
  cdp.on('Runtime.executionContextCreated', ({ context }) => {
    if (context.auxData?.type === 'isolated' && context.origin.startsWith('chrome-extension://')) {
      isolated.set(context.id, context.name);
    }
  });
  cdp.on('Runtime.exceptionThrown', ({ exceptionDetails: d }) => {
    if (!isolated.has(d.executionContextId)) return;
    const frame = d.stackTrace?.callFrames?.[0];
    const where = frame ? ` at ${frame.functionName || '(anonymous)'} ${frame.url.split('/').pop()}:${frame.lineNumber + 1}` : '';
    contentLog.push({ step, kind: 'exception', text: `${d.exception?.description?.split('\n')[0] ?? d.text}${where}` });
  });
  cdp.on('Runtime.consoleAPICalled', (e) => {
    if (!isolated.has(e.executionContextId)) return;
    const text = e.args.map((a) => a.value ?? a.description ?? a.type).join(' ');
    contentLog.push({ step, kind: `console.${e.type}`, text });
  });
}

const classes = (node) => {
  const a = node.attributes ?? [];
  for (let i = 0; i < a.length; i += 2) if (a[i] === 'class') return a[i + 1].split(/\s+/);
  return [];
};
const idOf = (node) => {
  const a = node.attributes ?? [];
  for (let i = 0; i < a.length; i += 2) if (a[i] === 'id') return a[i + 1];
  return null;
};
/** Depth-first, through shadow roots; frames' documents are not entered. */
function findAll(node, pred, out = []) {
  if (pred(node)) out.push(node);
  for (const child of [...(node.shadowRoots ?? []), ...(node.children ?? [])]) findAll(child, pred, out);
  return out;
}
const textOf = (node) => findAll(node, (n) => n.nodeType === 3).map((n) => n.nodeValue).join('');

/**
 * The notices on the page, oldest first, as `what` (the "Blocked ..." line),
 * `text` (every text node) and `allowOnce` (whether it offers "Allow once").
 * Null when the notice container was never created.
 */
async function readNotices() {
  const { root: doc } = await cdp.send('DOM.getDocument', { depth: -1, pierce: true });
  const host = findAll(doc, (n) => idOf(n) === 'abg-toast-container')[0];
  if (!host) return null;
  const inner = findAll(host, (n) => classes(n).includes('abg-toast-inner'))[0];
  return (inner?.children ?? []).map((notice) => ({
    what: textOf(findAll(notice, (n) => classes(n).includes('abg-toast-what'))[0] ?? {}),
    text: findAll(notice, (n) => n.nodeType === 3).map((n) => n.nodeValue),
    allowOnce: findAll(notice, (n) => classes(n).includes('abg-toast-btn-allow')).length > 0,
  }));
}

function printNotices(label, notices) {
  console.log(`  ${label}: ${notices === null ? 'no notice container' : `${notices.length} notice(s), oldest first`}`);
  for (const [i, n] of (notices ?? []).entries()) console.log(`    ${i + 1}. ${JSON.stringify(n.text)}`);
}

function printContentLog(fromStep) {
  for (const e of contentLog.filter((x) => x.step === fromStep)) console.log(`    content script ${e.kind}: ${e.text}`);
}

const blockedTotal = () => worker.evaluate(async () => {
  const s = await chrome.storage.local.get('lifetimeStats');
  return s.lifetimeStats?.totalActionsBlocked ?? 0;
});

// ═════════════════════════════════════════════════════════════════════════════
try {
  console.log(`browser: ${await browser.version()}`);
  await attachWorker();
  await armAndReload();

  const page = await browser.newPage();
  cdp = await page.createCDPSession();
  watchContentScript();
  await cdp.send('Runtime.enable');
  await page.goto(fixtureUrl);
  check('content script runs in the fixture page', isolated.size > 0, [...isolated.values()].join(', '));

  // The content script asks the background for the tab's rule once loaded.
  const tabId = await worker.evaluate(async (u) => (await chrome.tabs.query({ url: `${u}*` }))[0]?.id, fixtureUrl);
  let armed = false;
  for (let i = 0; i < 40 && !armed; i++) {
    const state = await worker.evaluate((id) => chrome.tabs.sendMessage(id, {
      type: 'STATUS_QUERY', data: {}, sentAt: new Date().toISOString(),
    }).catch(() => null), tabId);
    armed = state?.monitorState?.activeRule?.id === readOnlyRule.id;
    if (!armed) await wait(250);
  }
  check('the fixture tab is under the Read-Only delegation', armed, `tab ${tabId}`);
  printContentLog('load');
  const blockedBefore = await blockedTotal();

  // The fixture's steps [1] to [3], 120 ms apart as the fixture runs them. Each
  // returns whether the fixture's own handler ran, which a blocked event prevents.
  const steps = [
    ['[1] synthetic click on the link', () => {
      linkHandled = false;
      document.getElementById('target-link').dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      return linkHandled;
    }],
    ['[2] synthetic keydown and input in the field', () => {
      inputHandled = false;
      const input = document.getElementById('target-input');
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true, cancelable: true }));
      input.dispatchEvent(new InputEvent('input', { data: 'a', bubbles: true, cancelable: true }));
      return inputHandled;
    }],
    ['[3] synthetic submit event on the form', () => {
      submitHandled = false;
      document.getElementById('target-form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      return submitHandled;
    }],
  ];
  // The fixture's spray (its step 1: 30 synthetic mouse moves and 6 synthetic
  // clicks on the page every 2 s, each click blocked) runs during the four
  // events, so a notice for its clicks is on the page when the first one is
  // blocked. It is stopped right after the submit event, as its Stop spray
  // button does, so its next burst cannot change the notices read below.
  console.log("\nfour blocked events, the fixture's spray running");
  step = 'spray';
  const sprayStart = Date.now();
  const since = () => ((Date.now() - sprayStart) / 1000).toFixed(2);
  await page.evaluate(() => { sprayBurst(); sprayTimer = setInterval(sprayBurst, 2000); });
  printNotices(`after the spray's first burst (+${since()} s)`, await readNotices());
  printContentLog('spray');
  let reachedPage = 0;
  for (const [i, [label, dispatch]] of steps.entries()) {
    await wait(120);
    step = label;
    if (await page.evaluate(dispatch)) reachedPage++;
    if (i === steps.length - 1) await page.evaluate(() => { clearInterval(sprayTimer); sprayTimer = null; });
    printNotices(`after ${label} (+${since()} s)`, await readNotices());
    printContentLog(label);
  }
  check('the click, the text input and the submission were blocked', reachedPage === 0, `${reachedPage} reached the page`);

  step = 'settle';
  await wait(700);
  const afterFour = await readNotices();
  printNotices('0.7 s later', afterFour);
  printContentLog('settle');
  const whats = (afterFour ?? []).map((n) => n.what);
  check('three notices', whats.length === 3, `${whats.length}`);
  check(
    "oldest first: the spray's six clicks and the link click, the keydown and the input, the form submission",
    JSON.stringify(whats) === JSON.stringify(['Blocked click. ×7', 'Blocked text input. ×2', 'Blocked form submission.']),
    JSON.stringify(whats),
  );
  const submission = (afterFour ?? []).find((n) => n.what === 'Blocked form submission.');
  check('the form submission notice offers no Allow once', submission !== undefined && !submission.allowOnce);

  // A click's or a text input's notice is dismissed after 8 s; a form
  // submission's stays.
  step = 'timeout';
  await wait(8_600);
  const afterTimeout = await readNotices();
  printNotices('9 s later', afterTimeout);
  printContentLog('timeout');
  check(
    'the form submission notice stays after the others time out',
    JSON.stringify((afterTimeout ?? []).map((n) => n.what)) === JSON.stringify(['Blocked form submission.']),
    JSON.stringify((afterTimeout ?? []).map((n) => n.what)),
  );

  console.log('\nten more blocked clicks');
  step = 'ten clicks';
  const clicksReached = await page.evaluate(async () => {
    let reached = 0;
    for (let i = 0; i < 10; i++) {
      linkHandled = false;
      document.getElementById('target-link').dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      if (linkHandled) reached++;
      await new Promise((r) => setTimeout(r, 100));
    }
    return reached;
  });
  await wait(300);
  const afterClicks = await readNotices();
  printNotices('after ten clicks', afterClicks);
  printContentLog('ten clicks');
  check('the ten clicks were blocked', clicksReached === 0, `${clicksReached} reached the page`);
  check('two notices', afterClicks?.length === 2, `${afterClicks?.length}`);
  check(
    'oldest first: the form submission, then the ten clicks on one notice',
    JSON.stringify((afterClicks ?? []).map((n) => n.what)) === JSON.stringify(['Blocked form submission.', 'Blocked click. ×10']),
    JSON.stringify((afterClicks ?? []).map((n) => n.what)),
  );

  // The spray's six clicks, the four events and the ten clicks.
  let blockedAfter = blockedBefore;
  for (let i = 0; i < 20 && blockedAfter < blockedBefore + 20; i++) { await wait(250); blockedAfter = await blockedTotal(); }
  note(`blocked actions counted: ${blockedBefore} -> ${blockedAfter}`);
  const thrown = contentLog.filter((e) => e.kind === 'exception');
  check('the content script threw no exception', thrown.length === 0, thrown.map((e) => `${e.step}: ${e.text}`).join(' | '));
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
