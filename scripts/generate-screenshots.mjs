/**
 * Generate popup screenshots for Chrome Web Store listing.
 * Usage: npm run build && npx puppeteer browsers install chrome && node scripts/generate-screenshots.mjs
 *
 * The captures are taken from the built popup in dist/, so run `npm run build`
 * first. Then run `node docs/screenshots/capture.mjs`, which captures the store
 * slides and promo tiles from docs/screenshots/generate.html, a page that
 * embeds these captures. Both scripts record the checksums of the images they
 * write in docs/screenshots/checksums.json (scripts/screenshot-checksums.mjs).
 *
 * The page the captures are taken from has no chrome.* APIs, so the popup
 * script renders nothing in it and each capture stages its state in the static
 * HTML. The kill switch key in the header and the Pause the guard panel, which
 * the popup fills at run time, are drawn for each capture by
 * scripts/screenshot-popup-parts.mjs. The timelines of the detection and kill
 * switch captures are drawn by scripts/screenshot-timeline.mjs, as the popup
 * draws the stored sessions. The detection panel, the kill switch button and
 * the Network Activity panel are drawn for each capture by
 * scripts/screenshot-panels.mjs.
 */

import { createServer } from 'http';
import { readFileSync, existsSync, statSync } from 'fs';
import { join, extname } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { checksumsOf, recordChecksums } from './screenshot-checksums.mjs';
import { drawPopupRuntimeParts } from './screenshot-popup-parts.mjs';
import { drawTimeline, KILL_SWITCH_SESSIONS } from './screenshot-timeline.mjs';
import { DETECTED_AGENTS, DETECTION_SESSIONS, drawPopupPanels } from './screenshot-panels.mjs';
import { resolveStaticPath } from './static-path.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const DIST_DIR = join(__dirname, '..', 'dist');
const SCREENSHOTS_DIR = join(__dirname, '..', 'docs', 'screenshots');
// The key the captures show beside the Kill Switch button: the one the
// manifest suggests for the kill switch command on Windows and Linux.
const KILL_SWITCH_KEY = JSON.parse(readFileSync(join(__dirname, '..', 'manifest.json'), 'utf-8'))
  .commands['kill-switch'].suggested_key.default;
// The stored sessions the timeline of a capture shows, drawn as the popup
// draws them.
const TIMELINE_SESSIONS = { '1-detection': DETECTION_SESSIONS, '4-killswitch': KILL_SWITCH_SESSIONS };
// The agents the popup lists as detected in a capture. A capture not named
// here has none.
const DETECTED = { '1-detection': DETECTED_AGENTS };
// The captures taken while a delegation is active.
const DELEGATION_ACTIVE = ['3-readOnly'];

// Without a build the server answers 404 for the popup page, and the first
// capture's setup function fails on that page with a TypeError.
if (!existsSync(join(DIST_DIR, 'popup', 'index.html'))) {
  console.error('dist/popup/index.html not found. Run `npm run build` first.');
  process.exit(1);
}

const MIME_TYPES = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.woff2': 'font/woff2',
  '.png': 'image/png',
};

// Simple static file server for dist/. A request path that resolves outside
// dist/, such as /../package.json, or to a directory answers 404.
function startServer() {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      const filePath = resolveStaticPath(DIST_DIR, req.url === '/' ? '/popup/index.html' : req.url);
      if (!filePath || !existsSync(filePath) || statSync(filePath).isDirectory()) {
        res.writeHead(404);
        res.end('Not found');
        return;
      }
      const ext = extname(filePath);
      const mime = MIME_TYPES[ext] || 'application/octet-stream';
      res.writeHead(200, { 'Content-Type': mime });
      res.end(readFileSync(filePath));
    });
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      resolve({ server, port });
    });
  });
}

async function main() {
  // Dynamic import puppeteer
  const puppeteer = await import('puppeteer');
  const browser = await puppeteer.launch({ headless: true });

  const { server, port } = await startServer();
  const baseUrl = `http://127.0.0.1:${port}/popup/index.html`;

  console.log(`Server running on port ${port}`);

  const POPUP_WIDTH = 360;
  const POPUP_HEIGHT = 500;
  const captured = [];

  // `popupState` names the state of the parts the popup fills at run time:
  // `currentHost`, the hostname of the page in the active tab, and whether the
  // kill switch is on.
  async function screenshot(name, setupFn, popupState) {
    const page = await browser.newPage();
    await page.setViewport({ width: POPUP_WIDTH, height: POPUP_HEIGHT, deviceScaleFactor: 2 });
    // The timeline shows its times in the page's locale and time zone, as the
    // popup does. Set both, so that a capture does not depend on the settings
    // of the machine it is taken on.
    await page.emulateTimezone('UTC');
    const cdp = await page.createCDPSession();
    await cdp.send('Emulation.setLocaleOverride', { locale: 'en-US' });
    // A detection card says what the version of Chrome the popup runs in does
    // about remote debugging, read from navigator.userAgent, where
    // chrome-headless-shell names itself HeadlessChrome. Report the same
    // version under the name Chrome reports, as the popup reads it in Chrome.
    const userAgent = await page.evaluate(() => navigator.userAgent);
    await cdp.send('Emulation.setUserAgentOverride', { userAgent: userAgent.replace('HeadlessChrome/', 'Chrome/') });
    await page.goto(baseUrl, { waitUntil: 'networkidle0' });

    // Wait for font to load
    await page.evaluate(() => document.fonts.ready);

    // Turn off animations and transitions, such as the pulse of the status
    // dot while an agent is detected, so that the pixels of a capture do not
    // depend on the moment it is taken.
    await page.addStyleTag({ content: '*, *::before, *::after { animation: none !important; transition: none !important; }' });

    // Remove the JS-driven popup behavior (it tries to call chrome.* APIs)
    // and set up the desired state
    await page.evaluate(setupFn);

    // The popup fills the timeline at run time from the stored sessions.
    // Draw it as the popup does for the sessions the capture stages.
    const sessions = TIMELINE_SESSIONS[name];
    if (sessions) await page.evaluate(drawTimeline, sessions);

    // The popup fills the kill switch key in the header and the Pause the
    // guard panel at run time from chrome.* APIs, which this page does not
    // have. Draw them as the popup does for the staged state.
    await page.evaluate(drawPopupRuntimeParts, { shortcut: KILL_SWITCH_KEY, ...popupState });

    // The popup fills the detection panel, sets the kill switch button and
    // adds the Network Activity panel at run time from the state the
    // background reports. Draw them as the popup does for the staged state.
    await page.evaluate(drawPopupPanels, {
      detectedAgents: DETECTED[name] ?? [],
      delegationActive: DELEGATION_ACTIVE.includes(name),
      killSwitchActive: popupState.killSwitchActive === true,
    });

    // The footer names the version of the build. Hide it so that a capture
    // does not show a version number the next release makes out of date.
    await page.evaluate(() => document.getElementById('footer').classList.add('hidden'));

    // Wait for render
    await new Promise(r => setTimeout(r, 200));

    const outputPath = join(SCREENSHOTS_DIR, `${name}.png`);
    await page.screenshot({ path: outputPath, clip: { x: 0, y: 0, width: POPUP_WIDTH, height: POPUP_HEIGHT } });
    console.log(`Saved: ${outputPath}`);
    captured.push(`${name}.png`);
    await page.close();
  }

  // Screenshot 1: Detection - Agent detected
  await screenshot('1-detection', () => {
    // Set status to "detected"
    const indicator = document.getElementById('status-indicator');
    indicator.className = 'status-badge status-detected';
    document.getElementById('status-text').textContent = '2 Agent(s) Detected';

    // The detection cards and the kill switch button are drawn from
    // DETECTED, and the timeline from TIMELINE_SESSIONS, the sessions of the
    // two detected agents.
  }, { currentHost: 'app.example.com' });

  // Screenshot 2: Delegation - Wizard showing presets
  await screenshot('2-delegation', () => {
    // Show wizard
    const wizard = document.getElementById('wizard-container');
    wizard.classList.remove('hidden');

    // Update delegation content to show wizard active
    const delegContent = document.getElementById('delegation-content');
    delegContent.innerHTML = `
      <div class="delegation-empty">
        <span class="placeholder-text-inline" style="font-weight:600;">Select Access Preset</span>
      </div>
    `;

    wizard.innerHTML = `
      <div class="wizard-step">
        <div class="preset-card" style="margin-bottom: 8px;">
          <div class="preset-name">Read-Only</div>
          <div class="preset-description">Navigate and read page content only. No form input, clicks, or data modification.</div>
        </div>
        <div class="preset-card" style="margin-bottom: 8px;">
          <div class="preset-name">Limited Access</div>
          <div class="preset-description">Specific sites only, time-bounded. Form input and clicks allowed within scope.</div>
        </div>
        <div class="preset-card">
          <div class="preset-name">Full Access</div>
          <div class="preset-description">Agent can perform any action on any site for 60 minutes, then the grant expires. All activity is logged.</div>
        </div>
        <div class="wizard-nav">
          <button class="btn btn-secondary btn-sm" disabled>Back</button>
          <span style="font-size:11px;color:var(--text-muted);">Step 1 of 4</span>
          <button class="btn btn-primary btn-sm">Next</button>
        </div>
      </div>
    `;
  }, { currentHost: 'app.example.com' });

  // Screenshot 3: Read-Only config active
  await screenshot('3-readOnly', () => {
    // Set status to delegated
    const indicator = document.getElementById('status-indicator');
    indicator.className = 'status-badge status-delegated';
    document.getElementById('status-text').textContent = 'Delegated';

    // Show active delegation
    const delegContent = document.getElementById('delegation-content');
    delegContent.innerHTML = `
      <div class="delegation-empty">
        <span><strong>Read-Only</strong> <span style="font-size:12px;color:var(--color-warning);font-weight:500;">(45m remaining)</span></span>
        <button class="btn btn-secondary btn-sm">Change</button>
      </div>
    `;

    // Show capabilities summary
    const wizard = document.getElementById('wizard-container');
    wizard.classList.remove('hidden');
    wizard.innerHTML = `
      <div style="padding: 8px 0;">
        <div style="font-size:11px;font-weight:600;color:var(--text-secondary);text-transform:uppercase;letter-spacing:0.06em;margin-bottom:6px;">Active Capabilities</div>
        <div style="display:flex;flex-wrap:wrap;gap:4px;">
          <span class="method-tag" style="background:var(--color-safe-bg);border-color:var(--color-safe);color:var(--color-safe);">navigate</span>
          <span class="method-tag" style="background:var(--color-safe-bg);border-color:var(--color-safe);color:var(--color-safe);">read-dom</span>
          <span class="method-tag" style="background:var(--color-danger-bg);border-color:var(--color-danger);color:var(--color-danger);text-decoration:line-through;">click</span>
          <span class="method-tag" style="background:var(--color-danger-bg);border-color:var(--color-danger);color:var(--color-danger);text-decoration:line-through;">type-input</span>
          <span class="method-tag" style="background:var(--color-danger-bg);border-color:var(--color-danger);color:var(--color-danger);text-decoration:line-through;">submit-form</span>
          <span class="method-tag" style="background:var(--color-danger-bg);border-color:var(--color-danger);color:var(--color-danger);text-decoration:line-through;">download</span>
          <span class="method-tag" style="background:var(--color-danger-bg);border-color:var(--color-danger);color:var(--color-danger);text-decoration:line-through;">upload</span>
        </div>
        <div style="font-size:11px;font-weight:600;color:var(--text-secondary);text-transform:uppercase;letter-spacing:0.06em;margin-top:8px;margin-bottom:4px;">Site Scope</div>
        <div style="font-size:12px;color:var(--text-primary);font-family:var(--font-mono);">*.example.com, docs.internal.io</div>
      </div>
    `;

    // Show violations panel
    const violations = document.getElementById('violations-panel');
    violations.classList.remove('hidden');
    document.getElementById('violations-list').innerHTML = `
      <div class="event-item">
        <div style="width:8px;height:8px;border-radius:50%;margin-top:4px;flex-shrink:0;background-color:var(--color-danger);"></div>
        <div style="flex:1;min-width:0;">
          <div style="display:flex;justify-content:space-between;">
            <span style="font-size:13px;font-weight:600;">Click blocked</span>
            <span class="severity-badge severity-badge-high">BLOCKED</span>
          </div>
          <div style="font-size:12px;color:var(--text-secondary);font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">app.example.com/settings</div>
          <div style="font-size:11px;color:var(--text-secondary);font-weight:500;">14:38:22</div>
        </div>
      </div>
    `;
  }, { currentHost: 'app.example.com' });

  // Screenshot 4: Kill Switch activated
  await screenshot('4-killswitch', () => {
    // Set status to killed
    const indicator = document.getElementById('status-indicator');
    indicator.className = 'status-badge status-killed';
    document.getElementById('status-text').textContent = 'Killed';

    // The kill switch button, which the popup labels Resume Monitoring while
    // the kill switch is on, and the empty detection panel are drawn by
    // drawPopupPanels. The timeline is drawn from TIMELINE_SESSIONS, the
    // sessions the kill switch ended.

    // Delegation cleared
    document.getElementById('delegation-content').innerHTML = `
      <div class="delegation-empty">
        <span class="placeholder-text-inline">No delegation active</span>
        <button class="btn btn-primary btn-sm" disabled>Configure</button>
      </div>
    `;
  }, { currentHost: 'app.example.com', killSwitchActive: true });

  await browser.close();
  server.close();
  recordChecksums(SCREENSHOTS_DIR, 'popupCaptures', { files: checksumsOf(SCREENSHOTS_DIR, captured) });
  console.log('All screenshots generated.');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
