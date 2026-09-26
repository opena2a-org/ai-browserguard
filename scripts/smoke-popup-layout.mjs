/**
 * Popup layout smoke test at the popup's real width (360 px).
 *
 * Serves the built dist/ over a local HTTP server, stubs the `chrome` APIs the
 * popup calls (so the background status can be scripted), and renders the real
 * popup bundle in headless Chromium for each scenario and agent type:
 *
 *   fresh   one download block inside the callout window
 *   mixed   two download blocks and one click block, all fresh
 *   stale   one download block older than the callout window
 *   blank   a host-less agent (about:blank) under Read-Only, no blocks
 *   norule  an agent with no delegation, no blocks
 *
 * Asserts, per render:
 *   - no horizontal overflow: document scrollWidth is exactly 360
 *   - exactly one .capability-recovery block when a download block exists, none otherwise
 *   - no title attribute carries any part of the recovery hint or detail
 *   - the disclosure summary is reachable by Tab (before Revoke when the block
 *     is in the callout) and Enter opens it
 *   - the trust pill renders on one line (height <= 20 px)
 *   - the scope caveat sits directly under the grant row
 *   - the pill label matches the caveat variant
 *
 * Usage: npm run build && npm run smoke:popup-layout
 * Exit code is non-zero if any assertion fails.
 */
import pw from '../node_modules/playwright/index.js';
import { createServer } from 'http';
import { readFileSync, existsSync, statSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join, extname, normalize } from 'path';

const { chromium } = pw;
const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const DIST = join(ROOT, 'dist');
const POPUP_WIDTH = 360;

if (!existsSync(join(DIST, 'popup', 'index.html'))) {
  console.error('dist/popup/index.html not found. Run `npm run build` first.');
  process.exit(1);
}

// Read the user-facing strings from source so this guard never duplicates them.
const blockActionsSrc = readFileSync(join(ROOT, 'src/popup/block-actions.ts'), 'utf8');
const enforceabilitySrc = readFileSync(join(ROOT, 'src/delegation/enforceability.ts'), 'utf8');
const rulesSrc = readFileSync(join(ROOT, 'src/delegation/rules.ts'), 'utf8');
function stringConst(src, name) {
  const m = src.match(new RegExp(`export const ${name}\\s*=\\s*\\n?\\s*(['"\`])([\\s\\S]*?)\\1;`));
  if (!m) throw new Error(`could not read ${name} from source`);
  return m[2];
}
const fullAccessMinutes = rulesSrc.match(/export const FULL_ACCESS_MAX_MINUTES = (\d+);/)?.[1];
const HINT = stringConst(blockActionsSrc, 'CAPABILITY_BLOCK_HINT');
const DETAIL_BODY = stringConst(blockActionsSrc, 'CAPABILITY_BLOCK_DETAIL_BODY').replace(
  '${FULL_ACCESS_MAX_MINUTES}',
  fullAccessMinutes,
);
const DOWNLOADS_LABEL = stringConst(enforceabilitySrc, 'EXTERNAL_DRIVER_DOWNLOADS_ENFORCED_LABEL');

/** Every 24-character window of the recovery text: "any part" of it. */
function fragments(text, size = 24) {
  const out = [];
  for (let i = 0; i + size <= text.length; i += 8) out.push(text.slice(i, i + size));
  return out;
}
const RECOVERY_FRAGMENTS = [...fragments(HINT), ...fragments(DETAIL_BODY)];

const MIME = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
};
const server = createServer((req, res) => {
  const rel = normalize(decodeURIComponent((req.url ?? '/').split('?')[0])).replace(/^([/\\])+/, '');
  const file = join(DIST, rel);
  if (!file.startsWith(DIST) || !existsSync(file) || statSync(file).isDirectory()) {
    res.writeHead(404);
    res.end();
    return;
  }
  res.writeHead(200, { 'Content-Type': MIME[extname(file)] ?? 'application/octet-stream' });
  res.end(readFileSync(file));
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;

// ---------------------------------------------------------------------------
// Scenario state (the STATUS_QUERY response the popup renders)
// ---------------------------------------------------------------------------
const CAPABILITIES = [
  'navigate', 'read-dom', 'click', 'type-text', 'submit-form', 'download-file',
  'open-tab', 'close-tab', 'screenshot', 'execute-script', 'modify-dom', 'network-request',
];
const readOnlyRestrictions = CAPABILITIES.map((c) => ({
  capability: c,
  action: c === 'navigate' || c === 'read-dom' ? 'allow' : 'block',
}));

function buildState(scenario, agentType) {
  const now = Date.now();
  const iso = (ms) => new Date(ms).toISOString();
  const rule = (id, agentId) => ({
    id,
    preset: 'readOnly',
    scope: { sitePatterns: [], actionRestrictions: readOnlyRestrictions, timeBound: null },
    createdAt: iso(now),
    agentId,
    isActive: true,
  });
  const block = (id, action, url, agoMs) => ({
    violation: {
      id, timestamp: iso(now - agoMs), agentId: 'a1', attemptedAction: action, url,
      blockingRuleId: 'r-agent', reason: 'smoke', userOverride: false,
    },
    severity: 'high', title: 'Blocked', message: 'smoke', allowOneTimeOverride: false, acknowledged: false,
  });
  const violations = {
    fresh: [block('v1', 'download-file', 'https://shop.example.com/files/invoice-123.pdf', 5_000)],
    mixed: [
      block('v1', 'download-file', 'https://shop.example.com/files/invoice-123.pdf', 9_000),
      block('v2', 'click', 'https://shop.example.com/checkout', 7_000),
      block('v3', 'download-file', 'https://shop.example.com/files/receipt-77.pdf', 3_000),
    ],
    stale: [block('v1', 'download-file', 'https://shop.example.com/files/invoice-123.pdf', 10 * 60_000)],
    blank: [],
    norule: [],
  }[scenario];
  const rules = scenario === 'norule' ? [] : [rule('r-agent', 'a1'), rule('r-session', null)];
  return {
    detectedAgents: [{
      id: 'a1',
      type: agentType,
      detectionMethods: ['cdp-connection'],
      confidence: 'high',
      detectedAt: iso(now),
      originUrl: scenario === 'blank' ? 'about:blank' : 'https://shop.example.com/cart',
      observedCapabilities: [],
    }],
    aiSafetyDeclarations: {},
    activeDelegation: rules[1] ?? null,
    delegationRules: rules,
    killSwitchActive: false,
    recentViolations: violations,
  };
}

// ---------------------------------------------------------------------------
// Assertions
// ---------------------------------------------------------------------------
const failures = [];
function check(name, cond, detail = '') {
  if (cond) console.log(`  PASS  ${name}`);
  else {
    console.log(`  FAIL  ${name} ${detail}`);
    failures.push(name);
  }
}

const browser = await chromium.launch({ headless: true });
try {
  for (const agentType of ['anthropic-computer-use', 'playwright']) {
    for (const scenario of ['fresh', 'mixed', 'stale', 'blank', 'norule']) {
      const label = `${agentType}/${scenario}`;
      console.log(`\n${label}`);
      const state = buildState(scenario, agentType);
      const ctx = await browser.newContext({ viewport: { width: POPUP_WIDTH, height: 600 } });
      await ctx.addInitScript((s) => {
        const responses = {
          STATUS_QUERY: s,
          SESSION_QUERY: { sessions: [] },
          REPORTS_QUERY: { reports: [] },
          CONTRIBUTE_STATS: {},
        };
        window.chrome = {
          runtime: {
            id: 'smoke-extension',
            lastError: undefined,
            getManifest: () => ({ version: '0.0.0-smoke' }),
            onMessage: { addListener() {}, removeListener() {} },
            sendMessage(msg, cb) { setTimeout(() => cb && cb(responses[msg.type] ?? {}), 0); },
          },
          storage: {
            local: { get: async () => ({}), set: async () => {}, remove: async () => {} },
            onChanged: { addListener() {}, removeListener() {} },
          },
        };
      }, state);
      const page = await ctx.newPage();
      const pageErrors = [];
      page.on('pageerror', (e) => pageErrors.push(String(e)));
      await page.goto(`http://127.0.0.1:${port}/popup/index.html`);
      await page.waitForSelector('.detection-card', { timeout: 10_000 });
      await page.evaluate(() => document.fonts.ready);
      await page.waitForTimeout(200);

      const m = await page.evaluate(() => {
        const card = document.querySelector('.detection-card');
        const pill = card.querySelector('.detection-card-header .agent-pill');
        const caveat = card.querySelector('.agent-scope-caveat');
        const callout = document.getElementById('recent-block-callout');
        const all = [...document.querySelectorAll('.capability-recovery')];
        const inCallout = [...callout.querySelectorAll('.capability-recovery')];
        return {
          scrollWidth: document.documentElement.scrollWidth,
          recoveryCount: all.length,
          recoveryInCallout: inCallout.length,
          titles: [...document.querySelectorAll('[title]')].map((el) => el.getAttribute('title') ?? ''),
          pillText: pill ? pill.textContent : null,
          pillHeight: pill ? pill.getBoundingClientRect().height : null,
          caveatText: caveat ? caveat.textContent : null,
          caveatAfterGrant: caveat ? !!caveat.previousElementSibling?.classList.contains('agent-grant-row') : null,
          hasRevoke: [...card.querySelectorAll('button')].some((b) => b.textContent === 'Revoke'),
        };
      });

      const hasDownloadBlock = state.recentViolations.some((a) => a.violation.attemptedAction === 'download-file');
      check(`${label}: no horizontal overflow (scrollWidth ${m.scrollWidth})`, m.scrollWidth === POPUP_WIDTH);
      check(
        `${label}: ${hasDownloadBlock ? 'exactly one' : 'no'} recovery block (found ${m.recoveryCount})`,
        m.recoveryCount === (hasDownloadBlock ? 1 : 0),
      );
      const leaking = m.titles.filter((t) => RECOVERY_FRAGMENTS.some((f) => t.includes(f)));
      check(`${label}: no title carries recovery text`, leaking.length === 0, JSON.stringify(leaking));
      check(`${label}: pill renders on one line (${m.pillHeight} px)`, m.pillHeight !== null && m.pillHeight <= 20);

      const hasRule = scenario !== 'norule';
      const downloadsEnforced = hasRule && scenario !== 'blank';
      check(
        `${label}: pill label "${m.pillText}" matches the caveat variant`,
        m.pillText === (downloadsEnforced ? DOWNLOADS_LABEL : 'Monitor only') &&
          (m.caveatText ?? '').includes('downloads from shop.example.com are cancelled') === downloadsEnforced,
      );
      if (hasRule) {
        check(`${label}: caveat sits directly under the grant row`, m.caveatAfterGrant === true);
      } else {
        check(`${label}: no caveat without a rule`, m.caveatText === null);
      }

      if (m.recoveryCount === 1) {
        // Keyboard path: Tab to the summary, Enter opens the disclosure.
        const order = [];
        let opened = null;
        for (let i = 0; i < 25; i++) {
          await page.keyboard.press('Tab');
          const f = await page.evaluate(() => {
            const a = document.activeElement;
            if (!a) return 'none';
            if (a.tagName === 'SUMMARY' && a.closest('.capability-recovery')) return 'summary';
            return a.tagName === 'BUTTON' ? `button:${a.textContent.trim()}` : a.tagName.toLowerCase();
          });
          order.push(f);
          if (f === 'summary' && opened === null) {
            await page.keyboard.press('Enter');
            await page.waitForTimeout(50);
            opened = await page.evaluate(() => document.querySelector('.capability-recovery details').open);
            const w = await page.evaluate(() => document.documentElement.scrollWidth);
            check(`${label}: no overflow with the disclosure open (scrollWidth ${w})`, w === POPUP_WIDTH);
          }
          if (f === 'summary' && order.includes('button:Revoke')) break;
          if (order.includes('summary') && order.includes('button:Revoke')) break;
        }
        const si = order.indexOf('summary');
        const ri = order.indexOf('button:Revoke');
        check(`${label}: summary is reachable by Tab`, si >= 0, JSON.stringify(order));
        if (m.recoveryInCallout === 1 && m.hasRevoke) {
          check(`${label}: summary comes before Revoke in Tab order`, si >= 0 && (ri < 0 || si < ri), JSON.stringify(order));
        }
        check(`${label}: Enter opens the disclosure`, opened === true);
      }

      check(`${label}: no page errors`, pageErrors.length === 0, pageErrors.join(' | '));
      await ctx.close();
    }
  }
} finally {
  await browser.close();
  server.close();
}

console.log(`\n${failures.length === 0 ? 'PASS' : 'FAIL'}: popup layout smoke (${failures.length} failure(s))`);
process.exit(failures.length === 0 ? 0 : 1);
