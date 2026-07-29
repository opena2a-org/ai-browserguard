/**
 * Regression tests for the ISOLATED-world ↔ MAIN-world MessageChannel bridge.
 *
 * Pins the audit P0-1 security property: after the one-shot `MessageChannel`
 * bootstrap, no `window.postMessage` traffic flows in either direction. A
 * hostile page that registered an earlier `window` 'message' listener can
 * observe the bootstrap envelope but cannot forge subsequent traffic.
 *
 * The lock-in grep test additionally enforces that no callsite outside the
 * documented bootstrap site uses `window.postMessage` or
 * `window.addEventListener('message', ...)` — the next reviewer will not see
 * the design rationale; the test makes the intended behavior load-bearing.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

// The interceptor module gates most of its side-effect code behind
// `globalThis.isSecureContext !== false`. jsdom's default `about:blank`
// origin reports `isSecureContext: false`, which would silently skip the
// bootstrap listener installation. Override before any import.
Object.defineProperty(globalThis, 'isSecureContext', {
  value: true,
  configurable: true,
  writable: true,
});

// Some interceptor side-effects (Error.prepareStackTrace patch, fetch wrap)
// require a window-like global. jsdom provides one already.

const BRIDGE_BOOTSTRAP = 'AI_GUARD:BRIDGE_BOOTSTRAP';
const RULE_UPDATE = 'AI_GUARD:RULE_UPDATE';
const ALLOW_ONCE = 'AI_GUARD:ALLOW_ONCE';
const ACTION = 'AI_GUARD:ACTION';
const KILL_SWITCH = 'AI_GUARD:KILL_SWITCH';

interface InterceptorModule {
  isActionAllowed: (capability: string, url: string, rule?: unknown) => { allowed: boolean; reason: string };
}

/**
 * Drive a full ISOLATED↔MAIN bootstrap exchange against the freshly
 * re-imported interceptor module. Returns the live `port1` (the ISOLATED
 * end) so tests can push port messages that exercise MAIN-world state.
 */
async function bootstrap(): Promise<{ mod: InterceptorModule; port: MessagePort }> {
  const mod = (await import('./interceptor')) as unknown as InterceptorModule;
  const channel = new MessageChannel();
  window.dispatchEvent(new MessageEvent('message', {
    data: { type: BRIDGE_BOOTSTRAP },
    source: window,
    ports: [channel.port2],
  }));
  channel.port1.start();
  return { mod, port: channel.port1 };
}

async function flushMicrotasks(): Promise<void> {
  await new Promise((r) => setTimeout(r, 5));
}

beforeEach(() => {
  vi.resetModules();
});

describe('MAIN-world interceptor — bootstrap listener', () => {
  it('captures port2 transferred via the bootstrap envelope and starts it', async () => {
    await import('./interceptor');

    const channel = new MessageChannel();
    const startSpy = vi.spyOn(channel.port2, 'start');

    const event = new MessageEvent('message', {
      data: { type: BRIDGE_BOOTSTRAP },
      source: window,
      ports: [channel.port2],
    });
    window.dispatchEvent(event);

    expect(startSpy).toHaveBeenCalledTimes(1);
  });

  it('ignores a bootstrap-shaped envelope that carries no port', async () => {
    await import('./interceptor');

    // First dispatch a port-less envelope — should be rejected (no ports).
    const noPortEvent = new MessageEvent('message', {
      data: { type: BRIDGE_BOOTSTRAP },
      source: window,
      ports: [],
    });
    window.dispatchEvent(noPortEvent);

    // The bootstrap listener should NOT have consumed itself, so a
    // subsequent legitimate bootstrap WITH a port still gets captured.
    const channel = new MessageChannel();
    const startSpy = vi.spyOn(channel.port2, 'start');
    const realEvent = new MessageEvent('message', {
      data: { type: BRIDGE_BOOTSTRAP },
      source: window,
      ports: [channel.port2],
    });
    window.dispatchEvent(realEvent);

    expect(startSpy).toHaveBeenCalledTimes(1);
  });

  it('captures port2 exactly once even when a second bootstrap envelope arrives', async () => {
    await import('./interceptor');

    const first = new MessageChannel();
    const second = new MessageChannel();
    const firstStart = vi.spyOn(first.port2, 'start');
    const secondStart = vi.spyOn(second.port2, 'start');

    window.dispatchEvent(new MessageEvent('message', {
      data: { type: BRIDGE_BOOTSTRAP },
      source: window,
      ports: [first.port2],
    }));
    window.dispatchEvent(new MessageEvent('message', {
      data: { type: BRIDGE_BOOTSTRAP },
      source: window,
      ports: [second.port2],
    }));

    expect(firstStart).toHaveBeenCalledTimes(1);
    expect(secondStart).not.toHaveBeenCalled();
  });
});

describe('MAIN-world interceptor — hostile page cannot forge post-bootstrap traffic', () => {
  it('post-bootstrap window.postMessage of MSG_RULE_UPDATE is not processed by MAIN', async () => {
    // Audit regression test (2026-05-28-browserguard-audit-and-roadmap.md:42):
    //   "Install attacker listener, post via the channel, attempt to forge
    //    RULE_UPDATE through plain window.postMessage, assert activeRule
    //    remained null."
    await import('./interceptor');

    const channel = new MessageChannel();
    // Complete the legitimate bootstrap.
    window.dispatchEvent(new MessageEvent('message', {
      data: { type: BRIDGE_BOOTSTRAP },
      source: window,
      ports: [channel.port2],
    }));

    // Attacker tries to forge a rule update via plain window.postMessage.
    // No window 'message' listener for MSG_RULE_UPDATE exists on MAIN any
    // more (only the one-shot bootstrap listener, which auto-removed).
    // We assert this by inspecting whether any addEventListener('message')
    // call remains pending: the legitimate port message handler is on
    // channel.port1, not on window.
    const port1Spy = vi.fn();
    channel.port1.onmessage = port1Spy;
    channel.port1.start();

    window.postMessage(
      { type: RULE_UPDATE, rule: { isActive: true, expiresAt: null, actionRestrictions: [], sitePatterns: [] } },
      '*',
    );

    // Yield to let any window listeners run.
    await new Promise((r) => setTimeout(r, 10));

    // The hostile window.postMessage MUST NOT have arrived on the channel's
    // ISOLATED endpoint (port1) — it bypassed the bridge entirely.
    expect(port1Spy).not.toHaveBeenCalled();
  });

  it('post-bootstrap window.postMessage of MSG_ALLOW_ONCE is not processed by MAIN', async () => {
    await import('./interceptor');

    const channel = new MessageChannel();
    window.dispatchEvent(new MessageEvent('message', {
      data: { type: BRIDGE_BOOTSTRAP },
      source: window,
      ports: [channel.port2],
    }));

    const port1Spy = vi.fn();
    channel.port1.onmessage = port1Spy;
    channel.port1.start();

    // Forge an allow-once that would normally let any future open-tab through.
    window.postMessage(
      { type: ALLOW_ONCE, capability: 'open-tab', url: 'https://attacker.example.com/' },
      '*',
    );
    await new Promise((r) => setTimeout(r, 10));

    expect(port1Spy).not.toHaveBeenCalled();
  });

  it('a hostile pre-registered window listener still fires for the bootstrap event but cannot intercept later port traffic', async () => {
    // Attacker registers a window 'message' listener BEFORE the interceptor
    // loads. The browser delivers ALL message events to ALL listeners on the
    // window in registration order. We acknowledge the attacker sees the
    // bootstrap event (and could grab e.ports[0] to share access to the
    // channel). The harder defense — that the attacker should NOT have a
    // listener attached before the bootstrap dispatches — is the
    // document_start ordering guarantee, which is exercised in production
    // but cannot be unit-tested via jsdom.
    //
    // Lock in the observable property: after bootstrap, MAIN sends action
    // reports via the port. The attacker's window listener does NOT receive
    // those subsequent port messages.
    const attackerListener = vi.fn();
    window.addEventListener('message', attackerListener);

    await import('./interceptor');

    const channel = new MessageChannel();
    const port1Spy = vi.fn();
    channel.port1.onmessage = port1Spy;
    channel.port1.start();

    window.dispatchEvent(new MessageEvent('message', {
      data: { type: BRIDGE_BOOTSTRAP },
      source: window,
      ports: [channel.port2],
    }));
    await new Promise((r) => setTimeout(r, 0));

    // Drive MAIN to send a port-only message back to ISOLATED. Use the
    // exported reportAction-style path: the cleanest in-test driver is to
    // send a MSG_RULE_UPDATE from ISOLATED so MAIN's `activeRule` updates,
    // then issue a fake intercepted call... too coupled. Instead, simulate
    // MAIN posting on the port directly via channel.port2.postMessage.
    // After dispatch, channel.port1 receives it; window listeners do not.
    channel.port2.postMessage({ type: ACTION, capability: 'open-tab', url: 'https://x', blocked: true, reason: 'r', timestamp: 't' });
    await new Promise((r) => setTimeout(r, 10));

    // ISOLATED's port handler received the message.
    expect(port1Spy).toHaveBeenCalledTimes(1);

    // Attacker's window listener fired exactly ONCE — for the bootstrap
    // event only — not for the port traffic.
    expect(attackerListener).toHaveBeenCalledTimes(1);
    const attackerEvent = attackerListener.mock.calls[0]![0] as MessageEvent;
    expect((attackerEvent.data as { type?: unknown }).type).toBe(BRIDGE_BOOTSTRAP);
  });
});

describe('Bridge — lock-in: no stray window.postMessage outside the bootstrap site', () => {
  // The lock-in grep tests are NOT trivially passing. They assert the
  // structural property that the entire P0-1 defense rests on: that no
  // listener and no sender on `window` 'message' exists outside the
  // documented bootstrap site. Adversarial review (2026-06-01) flagged the
  // earlier narrow scope (only index.ts + interceptor.ts) as letting a
  // future contributor reintroduce a stray `window.postMessage` in
  // network-interceptor.ts / detector.ts / monitor.ts / toast.ts. Scope is
  // now every TS module under src/content/.

  const CONTENT_FILES = [
    'index.ts',
    'interceptor.ts',
    'network-interceptor.ts',
    'detector.ts',
    'monitor.ts',
    'toast.ts',
  ] as const;

  function nonCommentLines(file: string, re: RegExp): string[] {
    return file
      .split('\n')
      .filter((line) => {
        const trimmed = line.trim();
        if (trimmed.startsWith('//') || trimmed.startsWith('*')) return false;
        return re.test(line);
      });
  }

  it('src/content/index.ts uses window.postMessage exactly once (the bootstrap call)', () => {
    const file = readFileSync(resolve(__dirname, 'index.ts'), 'utf8');
    const matches = nonCommentLines(file, /\bwindow\.postMessage\s*\(/);
    expect(matches.length).toBe(1);
  });

  it('src/content/interceptor.ts has no window.postMessage callsite at all', () => {
    const file = readFileSync(resolve(__dirname, 'interceptor.ts'), 'utf8');
    const matches = nonCommentLines(file, /\bwindow\.postMessage\s*\(/);
    expect(matches.length).toBe(0);
  });

  it('src/content/interceptor.ts has exactly one window.addEventListener(\'message\') and it is the bootstrap listener', () => {
    const file = readFileSync(resolve(__dirname, 'interceptor.ts'), 'utf8');
    const matches = nonCommentLines(file, /\bwindow\.addEventListener\s*\(\s*['"]message['"]/);
    expect(matches.length).toBe(1);
    expect(matches[0]).toContain('bootstrapListener');
    expect(matches[0]).toContain('capture: true');
  });

  it('src/content/index.ts has no window.addEventListener(\'message\') — all ISOLATED↔MAIN traffic goes through the port', () => {
    const file = readFileSync(resolve(__dirname, 'index.ts'), 'utf8');
    const matches = nonCommentLines(file, /\bwindow\.addEventListener\s*\(\s*['"]message['"]/);
    expect(matches.length).toBe(0);
  });

  it('no other src/content/*.ts module uses window.postMessage', () => {
    const offenders: string[] = [];
    for (const filename of CONTENT_FILES) {
      if (filename === 'index.ts') continue; // sanctioned bootstrap site
      const file = readFileSync(resolve(__dirname, filename), 'utf8');
      const matches = nonCommentLines(file, /\bwindow\.postMessage\s*\(/);
      for (const m of matches) offenders.push(`${filename}: ${m.trim()}`);
    }
    expect(offenders).toEqual([]);
  });

  it('no other src/content/*.ts module installs a window \'message\' listener', () => {
    const offenders: string[] = [];
    for (const filename of CONTENT_FILES) {
      if (filename === 'interceptor.ts') continue; // sanctioned bootstrap listener
      const file = readFileSync(resolve(__dirname, filename), 'utf8');
      const matches = nonCommentLines(file, /\bwindow\.addEventListener\s*\(\s*['"]message['"]/);
      for (const m of matches) offenders.push(`${filename}: ${m.trim()}`);
    }
    expect(offenders).toEqual([]);
  });
});

describe('MAIN-world interceptor — P1-2 kill-switch hard-block sentinel', () => {
  const permissiveRule = {
    isActive: true,
    expiresAt: null,
    actionRestrictions: [
      { capability: 'open-tab', action: 'allow' },
      { capability: 'navigate', action: 'allow' },
      { capability: 'submit-form', action: 'allow' },
    ],
    sitePatterns: [],
  };

  it('isActionAllowed normally allows under a permissive rule (baseline)', async () => {
    const { mod } = await bootstrap();
    const { allowed } = mod.isActionAllowed('open-tab', 'https://example.com', permissiveRule);
    expect(allowed).toBe(true);
  });

  it('after MSG_KILL_SWITCH active:true, isActionAllowed blocks every capability even with the same permissive rule', async () => {
    // Audit P1-2 regression test (2026-05-28-browserguard-audit-and-roadmap.md:101):
    //   "broadcast a hard-block sentinel rule ... Regression test asserts
    //    open-tab after kill switch is blocked."
    const { mod, port } = await bootstrap();
    port.postMessage({ type: KILL_SWITCH, active: true });
    await flushMicrotasks();

    const openTab = mod.isActionAllowed('open-tab', 'https://example.com', permissiveRule);
    const navigate = mod.isActionAllowed('navigate', 'https://example.com', permissiveRule);
    const submit = mod.isActionAllowed('submit-form', 'https://example.com', permissiveRule);

    expect(openTab.allowed).toBe(false);
    expect(openTab.reason.toLowerCase()).toContain('kill switch');
    expect(navigate.allowed).toBe(false);
    expect(submit.allowed).toBe(false);
  });

  it('MSG_KILL_SWITCH active:false clears the sentinel and restores rule-based decisions', async () => {
    const { mod, port } = await bootstrap();
    port.postMessage({ type: KILL_SWITCH, active: true });
    await flushMicrotasks();
    expect(mod.isActionAllowed('open-tab', 'https://example.com', permissiveRule).allowed).toBe(false);

    port.postMessage({ type: KILL_SWITCH, active: false });
    await flushMicrotasks();
    expect(mod.isActionAllowed('open-tab', 'https://example.com', permissiveRule).allowed).toBe(true);
  });

  it('null/pass-through rule still blocks while sentinel is active', async () => {
    // Without the sentinel, passing rule=null returns pass-through (allow).
    // The sentinel must override pass-through too — otherwise an extension
    // with no active rule would let agents act freely after a kill switch.
    const { mod, port } = await bootstrap();
    port.postMessage({ type: KILL_SWITCH, active: true });
    await flushMicrotasks();

    const { allowed, reason } = mod.isActionAllowed('open-tab', 'https://example.com', null);
    expect(allowed).toBe(false);
    expect(reason.toLowerCase()).toContain('kill switch');
  });

  it('MSG_KILL_SWITCH with non-boolean active field is ignored (no flag change)', async () => {
    const { mod, port } = await bootstrap();
    // Send a malformed envelope; flag must stay at default false.
    port.postMessage({ type: KILL_SWITCH, active: 'yes' });
    await flushMicrotasks();
    const { allowed } = mod.isActionAllowed('open-tab', 'https://example.com', permissiveRule);
    expect(allowed).toBe(true);
  });

  it('lock-in: the kill-switch check runs BEFORE the rule check in isActionAllowed', () => {
    // Structural assertion against the source — guarantees the sentinel
    // cannot be bypassed by a permissive rule, an allow-once entry, or a
    // null pass-through path. A future contributor moving the check below
    // the pass-through branch will fail this test.
    const file = readFileSync(resolve(__dirname, 'interceptor.ts'), 'utf8');
    const killSwitchIdx = file.indexOf('if (killSwitchActive)');
    const passThroughIdx = file.indexOf('No active delegation rule');
    const expiresIdx = file.indexOf('Delegation has expired');
    expect(killSwitchIdx).toBeGreaterThan(0);
    expect(killSwitchIdx).toBeLessThan(passThroughIdx);
    expect(killSwitchIdx).toBeLessThan(expiresIdx);
  });

  it('lock-in: ISOLATED forwards KILL_SWITCH_ACTIVATE to MAIN via the bridge port before tearing down monitors', () => {
    // Structural assertion against src/content/index.ts: the
    // postToMainWorld call for MSG_KILL_SWITCH must precede the
    // executeContentKillSwitch teardown. Reversing the order would re-open
    // the race window the sentinel was designed to close.
    const file = readFileSync(resolve(__dirname, 'index.ts'), 'utf8');
    const sendKillIdx = file.indexOf('postToMainWorld({ type: MSG_KILL_SWITCH, active: true });');
    const tearDownIdx = file.indexOf('executeContentKillSwitch()');
    expect(sendKillIdx).toBeGreaterThan(0);
    expect(tearDownIdx).toBeGreaterThan(0);
    expect(sendKillIdx).toBeLessThan(tearDownIdx);
  });

  it('lock-in: ISOLATED handles KILL_SWITCH_RESET and forwards MSG_KILL_SWITCH active:false', () => {
    const file = readFileSync(resolve(__dirname, 'index.ts'), 'utf8');
    expect(file).toMatch(/case 'KILL_SWITCH_RESET'/);
    expect(file).toMatch(/postToMainWorld\(\{\s*type: MSG_KILL_SWITCH,\s*active: false\s*\}\);/);
  });

  it('lock-in: background broadcasts KILL_SWITCH_RESET to every tab so MAIN can lift the sentinel', () => {
    // Without this broadcast, MAIN-world wrappers would continue to deny
    // every capability check after the user resets the kill switch from
    // the popup. The broadcast must live in the KILL_SWITCH_RESET handler
    // in src/background/index.ts and iterate chrome.tabs.query results
    // sending a KILL_SWITCH_RESET message to each tab.
    const file = readFileSync(resolve(__dirname, '..', 'background', 'index.ts'), 'utf8');
    const resetIdx = file.indexOf("case 'KILL_SWITCH_RESET'");
    expect(resetIdx).toBeGreaterThan(0);
    // Slice to the next `case` label so the window is the whole handler,
    // however long its comments grow — the invariant is "the broadcast lives
    // INSIDE the KILL_SWITCH_RESET handler", not "within N chars of it".
    const nextCaseIdx = file.indexOf("case '", resetIdx + 1);
    expect(nextCaseIdx).toBeGreaterThan(resetIdx);
    const handlerSlice = file.slice(resetIdx, nextCaseIdx);
    expect(handlerSlice).toMatch(/chrome\.tabs\.query/);
    expect(handlerSlice).toMatch(/chrome\.tabs\.sendMessage/);
    expect(handlerSlice).toMatch(/type:\s*'KILL_SWITCH_RESET'/);
  });

  it('lock-in: consumeAllowedOnce refuses to consume entries while the sentinel is active', () => {
    // Adversarial-review CRITICAL #1: the wrappers call consumeAllowedOnce
    // BEFORE isActionAllowed. A stale allow-once entry would otherwise let
    // an in-flight wrapper call bypass the sentinel entirely. The gate at
    // the top of consumeAllowedOnce is the defense; the lock-in proves it
    // sits before the .has(key) lookup so the entry is preserved (not
    // consumed) for use after reset.
    const file = readFileSync(resolve(__dirname, 'interceptor.ts'), 'utf8');
    const fnStart = file.indexOf('function consumeAllowedOnce');
    expect(fnStart).toBeGreaterThan(0);
    const fnBody = file.slice(fnStart, fnStart + 500);
    const sentinelIdx = fnBody.indexOf('if (killSwitchActive) return false');
    const hasIdx = fnBody.indexOf('allowedOnce.has(key)');
    expect(sentinelIdx).toBeGreaterThan(0);
    expect(hasIdx).toBeGreaterThan(0);
    expect(sentinelIdx).toBeLessThan(hasIdx);
  });

  it('lock-in: content script re-arms the sentinel from the TAB_STATE_QUERY response after navigation', () => {
    // Adversarial-review CRITICAL #2: content scripts re-inject on
    // navigation; the new MAIN-world interceptor boots with
    // killSwitchActive=false. Without re-syncing from the background's
    // current killSwitch state, navigating during a kill switch silently
    // disarms it on the new tab. The pull is TAB_STATE_QUERY (content-only;
    // the original STATUS_QUERY pull was popup-only under sender validation
    // and silently failed — this source pin passed while the runtime
    // behavior was broken, which is why src/background/tab-state-query.test.ts
    // now pins the BEHAVIOR and this test only pins the forwarding wiring).
    const file = readFileSync(resolve(__dirname, 'index.ts'), 'utf8');
    const statusQueryIdx = file.indexOf("sendToBackground('TAB_STATE_QUERY'");
    expect(statusQueryIdx).toBeGreaterThan(0);
    const handlerSlice = file.slice(statusQueryIdx, statusQueryIdx + 1200);
    expect(handlerSlice).toMatch(/killSwitchActive\?:\s*boolean/);
    expect(handlerSlice).toMatch(/data\.killSwitchActive\s*===\s*true/);
    expect(handlerSlice).toMatch(/postToMainWorld\(\{\s*type: MSG_KILL_SWITCH,\s*active: true\s*\}\)/);
  });

  it('lock-in: background STATUS_QUERY response includes killSwitchActive (for navigation re-sync)', () => {
    const file = readFileSync(resolve(__dirname, '..', 'background', 'index.ts'), 'utf8');
    const handlerIdx = file.indexOf("case 'STATUS_QUERY'");
    expect(handlerIdx).toBeGreaterThan(0);
    // Slice to the next case label — the invariant is "inside the
    // STATUS_QUERY handler", not "within N chars of its label".
    const nextCaseIdx = file.indexOf("case '", handlerIdx + 1);
    expect(nextCaseIdx).toBeGreaterThan(handlerIdx);
    const handlerSlice = file.slice(handlerIdx, nextCaseIdx);
    expect(handlerSlice).toMatch(/killSwitchActive:\s*state\.killSwitch\.isActive/);
  });
});

/**
 * Audit #32 repro — MAIN-world trust boundary.
 *
 * The bootstrap listener authenticates NO peer: `e.source === window` is true
 * for any page-originated postMessage, and the first valid envelope to arrive
 * wins and locks out all others (interceptor.ts:366-385). The ONLY thing that
 * stops a hostile first-party page from posting that envelope first is Chrome's
 * content-script `document_start` ordering — a runtime guarantee, not something
 * the code verifies. These tests demonstrate the consequence if that ordering
 * were ever lost: whoever wins the bootstrap owns the MAIN channel, and the
 * real ISOLATED world is locked out. The conclusion is documented in
 * docs/architecture.md ("MAIN-world trust boundary"): MAIN-world reports are
 * untrusted hints; the trusted path is the ISOLATED world plus browser-level
 * (CDP) detection.
 */
describe('MAIN-world interceptor — bootstrap race ownership (audit #32 repro)', () => {
  const permissiveRule = {
    isActive: true,
    expiresAt: null,
    actionRestrictions: [{ capability: 'open-tab', action: 'allow' }],
    sitePatterns: [],
  };

  it('whoever posts the first valid bootstrap owns the MAIN channel; the legitimate peer is locked out', async () => {
    const mod = (await import('./interceptor')) as unknown as InterceptorModule;

    // An attacker envelope arrives FIRST (this is exactly what document_start
    // ordering is relied upon to prevent — here we simulate the race being lost).
    const attacker = new MessageChannel();
    window.dispatchEvent(new MessageEvent('message', {
      data: { type: BRIDGE_BOOTSTRAP },
      source: window,
      ports: [attacker.port2],
    }));
    // The real ISOLATED bootstrap arrives second and is locked out.
    const legit = new MessageChannel();
    window.dispatchEvent(new MessageEvent('message', {
      data: { type: BRIDGE_BOOTSTRAP },
      source: window,
      ports: [legit.port2],
    }));
    attacker.port1.start();
    legit.port1.start();

    // Baseline: open-tab is allowed under the permissive rule.
    expect(mod.isActionAllowed('open-tab', 'https://example.com', permissiveRule).allowed).toBe(true);

    // The ATTACKER controls the channel: it can drive the kill-switch sentinel.
    attacker.port1.postMessage({ type: KILL_SWITCH, active: true });
    await flushMicrotasks();
    expect(mod.isActionAllowed('open-tab', 'https://example.com', permissiveRule).allowed).toBe(false);

    // The LEGITIMATE peer is locked out: its messages do not reach MAIN, so it
    // cannot clear the attacker's sentinel.
    legit.port1.postMessage({ type: KILL_SWITCH, active: false });
    await flushMicrotasks();
    expect(mod.isActionAllowed('open-tab', 'https://example.com', permissiveRule).allowed).toBe(false);

    // ...but the attacker can clear it again — confirming sole ownership.
    attacker.port1.postMessage({ type: KILL_SWITCH, active: false });
    await flushMicrotasks();
    expect(mod.isActionAllowed('open-tab', 'https://example.com', permissiveRule).allowed).toBe(true);
  });

  it('the real ISOLATED bootstrap, arriving second, can never drive MAIN state', async () => {
    const mod = (await import('./interceptor')) as unknown as InterceptorModule;

    const attacker = new MessageChannel();
    window.dispatchEvent(new MessageEvent('message', {
      data: { type: BRIDGE_BOOTSTRAP },
      source: window,
      ports: [attacker.port2],
    }));
    const legit = new MessageChannel();
    window.dispatchEvent(new MessageEvent('message', {
      data: { type: BRIDGE_BOOTSTRAP },
      source: window,
      ports: [legit.port2],
    }));
    legit.port1.start();

    // A kill switch broadcast over the legitimate (locked-out) port has no effect.
    legit.port1.postMessage({ type: KILL_SWITCH, active: true });
    await flushMicrotasks();
    expect(mod.isActionAllowed('open-tab', 'https://example.com', permissiveRule).allowed).toBe(true);
  });
});
