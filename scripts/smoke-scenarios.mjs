/**
 * Behavioral scenario smoke test.
 *
 * Loads the built dist/ in a real Chrome, then drives real navigations and
 * real user/agent actions across several sites and asserts how the extension
 * RESPONDS -- not just that it loaded. This is the release gate that unit tests
 * cannot stand in for, because the extension's whole job (detect / monitor /
 * control agent activity) only exists at runtime in a real browser.
 *
 * Run headless for CI:        npm run smoke:scenarios
 * Run visible (watch it):     ABG_HEADFUL=1 npm run smoke:scenarios
 *
 * Observable surfaces (all code-grounded, see src/background/index.ts):
 *   - chrome.storage.local keys: sessions, detectionLog, lifetimeStats
 *   - STATUS_QUERY message -> { detectedAgents, killSwitchActive, ... }
 *   - KILL_SWITCH_ACTIVATE message
 *
 * Verdicts:
 *   PASS  assertion held
 *   FAIL  assertion broke -> non-zero exit (release blocker)
 *   FLAG  behavior observed worth a human's attention (not a blocker by itself)
 */
import puppeteer from 'puppeteer';
import { resolve } from 'node:path';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';

const dist = resolve(process.cwd(), 'dist');
const HEADFUL = process.env.ABG_HEADFUL === '1';
const downloadDir = mkdtempSync(resolve(tmpdir(), 'abg-dl-'));

const results = [];
const rec = (verdict, scenario, detail) => {
  results.push({ verdict, scenario, detail });
  console.log(`  ${verdict.padEnd(4)} ${scenario}${detail ? ' -- ' + detail : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// All verdicts read chrome.storage.local (durable across MV3 service-worker
// restarts). We deliberately do NOT gate on STATUS_QUERY: it returns in-memory
// state (activeAgents / killSwitch) that the extension correctly refuses to
// serve to a tab-hosted page (STATUS_QUERY is popup-only, sender-validation.ts),
// and that the SW loses on restart. Storage is the source of truth a release
// gate can trust.
async function readState(extPage) {
  return extPage.evaluate(async () => {
    const s = await chrome.storage.local.get(['sessions', 'detectionLog', 'lifetimeStats']);
    const sessions = s.sessions ?? [];
    const log = s.detectionLog ?? [];
    // Flatten every observable string in sessions so we can search for
    // download-attributable evidence without guessing the schema.
    const sessionBlob = JSON.stringify(sessions).toLowerCase();
    return {
      sessions: sessions.length,
      detections: log.length,
      killSwitchEndedSessions: sessions.filter((x) => x.endReason === 'kill-switch').length,
      detail: log.slice(-5).map((d) => ({
        confidence: d.confidence, methods: d.methods, agent: d.agent?.type ?? d.agent?.framework ?? null, url: d.url,
      })),
      mentionsDownload: /download|agent-download|agent-exfil-payload/.test(sessionBlob),
    };
  });
}

async function main() {
  const browser = await puppeteer.launch({
    headless: HEADFUL ? false : 'new',
    defaultViewport: null,
    args: [`--disable-extensions-except=${dist}`, `--load-extension=${dist}`, '--no-sandbox', '--no-first-run'],
  });

  try {
    const swTarget = await browser.waitForTarget(
      (t) => t.type() === 'service_worker' && t.url().includes('background/index.js'),
      { timeout: 10000 },
    );
    const extId = new URL(swTarget.url()).host;
    rec('PASS', '0. extension loads + SW boots', `id=${extId}`);

    // Stable extension-context page for all storage reads / messaging
    const extPage = await browser.newPage();
    await extPage.goto(`chrome-extension://${extId}/popup/index.html`, { waitUntil: 'domcontentloaded' });
    await sleep(400);

    // --- Scenario 1: storage readable + baseline ---
    const base = await readState(extPage);
    if (typeof base.detections === 'number' && typeof base.sessions === 'number') {
      rec('PASS', '1. durable state readable (storage.local)', `baseline: ${base.detections} detections, ${base.sessions} sessions`);
    } else {
      rec('FAIL', '1. durable state readable (storage.local)', JSON.stringify(base));
    }

    // --- Scenario 2: multi-site navigation + agent-style activity -> detection ---
    // The harness browser is itself automated (CDP-attached, navigator.webdriver),
    // which is exactly the agent class the guard exists to catch.
    const sites = ['https://example.com/', 'https://example.org/'];
    for (const url of sites) {
      const tab = await browser.newPage();
      await tab.goto(url, { waitUntil: 'domcontentloaded' }).catch(() => {});
      await tab.evaluate(async () => {
        try { await fetch(location.href + '?abg-agent-probe=1'); } catch {}
        const btn = document.createElement('button'); btn.textContent = 'x'; document.body.appendChild(btn);
        for (let i = 0; i < 5; i++) btn.click();
      }).catch(() => {});
      await sleep(300);
      await tab.close();
    }
    // poll up to ~8s for the guard to have recorded a detection of this
    // CDP/webdriver-automated browser (its core job).
    let detected = base;
    for (let i = 0; i < 16; i++) {
      detected = await readState(extPage);
      if (detected.detections > 0) break;
      await sleep(500);
    }
    if (detected.detections > 0) {
      const last = detected.detail[detected.detail.length - 1] ?? {};
      rec('PASS', '2. automated browser detected across navigations',
        `${detected.detections} detection(s); latest: ${last.agent ?? '?'} via ${(last.methods || []).join('+')} @ ${last.url ?? '?'}`);
    } else {
      rec('FAIL', '2. automated browser detected across navigations',
        `guard recorded NO detection of a CDP/webdriver-automated browser after visiting ${sites.length} sites`);
    }

    // --- Scenario 3: file download response ---
    const pre = await readState(extPage);
    const dl = await browser.newPage();
    const client = await dl.target().createCDPSession();
    await client.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: downloadDir });
    await dl.goto('https://example.com/', { waitUntil: 'domcontentloaded' }).catch(() => {});
    await dl.evaluate(() => {
      const a = document.createElement('a');
      a.href = 'data:text/plain;base64,' + btoa('agent-exfil-payload-' + Date.now());
      a.download = 'agent-download.txt';
      document.body.appendChild(a); a.click();
    });
    await sleep(2500);
    await dl.close();
    const post = await readState(extPage);
    // Credit ONLY download-attributable evidence -- not generic detectionLog
    // growth, which here is the periodic re-detection of the automated browser.
    if (post.mentionsDownload) {
      rec('PASS', '3. file download produced a download-attributable event');
    } else {
      rec('FLAG', '3. file download produced NO download-attributable event',
        'agent-initiated download recorded nothing referencing the download: incoming downloads are not monitored (downloads permission is export-only, src/background/index.ts:306; no `download` AgentEventType exists)');
    }

    // --- Scenario 4: kill switch ---
    // The kill switch is deliberately NOT triggerable from an automated tab:
    // KILL_SWITCH_ACTIVATE is popup-only (sender-validation.ts rejects messages
    // that carry a sender.tab). That is correct hardening, so this harness can
    // only confirm the durable side effect IF a kill switch already fired.
    // The trigger paths are covered elsewhere: the popup button, the
    // Cmd+Shift+K command (commands API, manifest.json), and unit tests.
    const beforeKill = await readState(extPage);
    const sent = await extPage.evaluate(async () => {
      try { const r = await chrome.runtime.sendMessage({ type: 'KILL_SWITCH_ACTIVATE', data: { trigger: 'test' } }); return r ?? 'no-response'; }
      catch (e) { return 'err:' + e.message; }
    });
    await sleep(1500);
    const killed = await readState(extPage);
    if (killed.killSwitchEndedSessions > beforeKill.killSwitchEndedSessions) {
      rec('PASS', '4. kill switch ended sessions (endReason=kill-switch)',
        `${beforeKill.killSwitchEndedSessions}->${killed.killSwitchEndedSessions}`);
    } else {
      rec('SKIP', '4. kill switch not triggerable from automation',
        `popup-only message rejected (response=${JSON.stringify(sent)}); verify via popup button / Cmd+Shift+K / unit tests`);
    }

    // --- summary ---
    const fails = results.filter((r) => r.verdict === 'FAIL');
    const flags = results.filter((r) => r.verdict === 'FLAG');
    console.log(`\n${fails.length === 0 ? 'NO FAILURES' : fails.length + ' FAILURE(S)'}` +
      `  |  ${results.filter((r) => r.verdict === 'PASS').length} pass, ${flags.length} flag, ${fails.length} fail`);
    if (flags.length) console.log('FLAGS (human review): ' + flags.map((f) => f.scenario).join('; '));
    process.exitCode = fails.length === 0 ? 0 : 1;
  } finally {
    await browser.close();
  }
}

main().catch((e) => { console.error('scenario harness crashed:', e); process.exitCode = 1; });
