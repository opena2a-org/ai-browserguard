/**
 * @vitest-environment jsdom
 *
 * Network-interceptor arming test.
 *
 * The MAIN-world `fetch`/`sendBeacon` wrappers must only be installed while
 * there is something to enforce (an active delegation rule, or the kill switch).
 * Installing them unconditionally puts this extension's frame in the call chain
 * of EVERY page request, so a page's own failed request — e.g. a site's
 * Content-Security-Policy refusing its analytics beacon — is attributed to this
 * extension in chrome://extensions, making a privacy-first tool look like the
 * source of blocked/suspicious traffic. (The XHR path already avoids this by
 * never wrapping `send()`.)
 *
 * These tests lock the gate: no rule → the page's native fetch/sendBeacon run
 * un-wrapped; an active rule or the kill switch → wrapped, and agent-attributed
 * requests are denied; rule cleared → native impls restored. The "does not wrap
 * at import" assertion FAILS on the prior unconditional-install code.
 */
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { MSG_BRIDGE_BOOTSTRAP, MSG_RULE_UPDATE, MSG_KILL_SWITCH } from './bridge-protocol';

interface TestRule {
  isActive: boolean;
  expiresAt: string | null;
  actionRestrictions: Array<{ capability: string; action: 'allow' | 'block' }>;
  sitePatterns: Array<{ pattern: string; action: 'allow' | 'block' }>;
}

let isNetworkInterceptorArmed: (rule: TestRule | null, killSwitch: boolean) => boolean;
let nativeFetch: typeof globalThis.fetch;
let nativeSendBeacon: typeof navigator.sendBeacon;
/** ISOLATED-side port: post rule/kill-switch updates to the interceptor through this. */
let toInterceptor: MessagePort;

/** Run a callback from inside a frame named like a CDP utility script. */
function asAgent<T>(fn: () => T): T {
  const UtilityScript = function UtilityScript(): T {
    return fn();
  };
  return UtilityScript();
}

/** Let queued MessagePort deliveries flush. */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

async function setRule(rule: TestRule | null): Promise<void> {
  toInterceptor.postMessage({ type: MSG_RULE_UPDATE, rule });
  await flush();
}

async function setKillSwitch(active: boolean): Promise<void> {
  toInterceptor.postMessage({ type: MSG_KILL_SWITCH, active });
  await flush();
}

/** Active rule with no network-request allowance → isActionAllowed denies it. */
function networkDenyingRule(): TestRule {
  return { isActive: true, expiresAt: null, actionRestrictions: [], sitePatterns: [] };
}

beforeAll(async () => {
  // The interceptor only installs its wrappers on a secure context.
  Object.defineProperty(globalThis, 'isSecureContext', { value: true, configurable: true });

  // Install sentinel native implementations BEFORE importing the module so we
  // can detect whether the module wrapped (replaced) them.
  nativeFetch = function fetchNative(): Promise<Response> {
    return Promise.resolve(new Response(''));
  } as unknown as typeof globalThis.fetch;
  globalThis.fetch = nativeFetch;
  nativeSendBeacon = function sendBeaconNative(): boolean {
    return true;
  } as unknown as typeof navigator.sendBeacon;
  Object.defineProperty(navigator, 'sendBeacon', {
    value: nativeSendBeacon,
    configurable: true,
    writable: true,
  });

  const mod = await import('./interceptor');
  isNetworkInterceptorArmed = mod.isNetworkInterceptorArmed as typeof isNetworkInterceptorArmed;

  // Complete the MAIN-world bridge handshake the way the ISOLATED world does.
  const channel = new MessageChannel();
  toInterceptor = channel.port1;
  toInterceptor.start();
  window.dispatchEvent(
    new MessageEvent('message', {
      data: { type: MSG_BRIDGE_BOOTSTRAP },
      source: window,
      ports: [channel.port2],
    }),
  );
  await flush();
});

afterEach(async () => {
  // Return to the disarmed baseline between tests.
  await setKillSwitch(false);
  await setRule(null);
});

describe('isNetworkInterceptorArmed (pure)', () => {
  it('is armed when the kill switch is active, regardless of rule', () => {
    expect(isNetworkInterceptorArmed(null, true)).toBe(true);
  });

  it('is armed when any rule is active', () => {
    expect(isNetworkInterceptorArmed(networkDenyingRule(), false)).toBe(true);
  });

  it('is NOT armed without a rule or kill switch', () => {
    expect(isNetworkInterceptorArmed(null, false)).toBe(false);
    expect(isNetworkInterceptorArmed({ ...networkDenyingRule(), isActive: false }, false)).toBe(false);
  });
});

describe('network interceptor install gating', () => {
  it('does NOT wrap fetch or sendBeacon at import when no rule is active', () => {
    // Fails on the prior code, which installed the wrappers unconditionally at
    // document_start and thus replaced both natives before any rule existed.
    expect(globalThis.fetch).toBe(nativeFetch);
    expect(navigator.sendBeacon).toBe(nativeSendBeacon);
  });

  it('wraps fetch under an active rule and denies an agent-attributed request', async () => {
    await setRule(networkDenyingRule());
    expect(globalThis.fetch).not.toBe(nativeFetch);

    // Agent-attributed (CDP stack) request is denied.
    await expect(asAgent(() => globalThis.fetch('https://example.test/x'))).rejects.toThrow(/blocked/i);

    // A page/user request (no CDP stack signature) still passes through.
    await expect(globalThis.fetch('https://example.test/y')).resolves.toBeInstanceOf(Response);
  });

  it('wraps under the kill switch even with no rule', async () => {
    await setKillSwitch(true);
    expect(globalThis.fetch).not.toBe(nativeFetch);
    expect(navigator.sendBeacon).not.toBe(nativeSendBeacon);
  });

  it('restores the native fetch and sendBeacon when the rule is cleared', async () => {
    await setRule(networkDenyingRule());
    expect(globalThis.fetch).not.toBe(nativeFetch);

    await setRule(null);
    expect(globalThis.fetch).toBe(nativeFetch);
    expect(navigator.sendBeacon).toBe(nativeSendBeacon);
  });

  it('restores the exact natives when the kill switch is lifted', async () => {
    await setKillSwitch(true);
    expect(globalThis.fetch).not.toBe(nativeFetch);
    expect(navigator.sendBeacon).not.toBe(nativeSendBeacon);

    await setKillSwitch(false);
    expect(globalThis.fetch).toBe(nativeFetch);
    expect(navigator.sendBeacon).toBe(nativeSendBeacon);
  });

  it('KNOWN LIMIT: a fetch reference captured while disarmed bypasses a wrapper armed later', async () => {
    // This pins a documented boundary, not a desired behavior. Because the
    // wrappers install only when armed (the whole point of this fix — staying
    // out of Chrome's failure-attribution chain for page-own requests), a
    // reference captured while disarmed stays native, and arming later cannot
    // reach it. This is one more route in the already-documented best-effort
    // MAIN-world boundary (iframe/Worker-fresh fetch, global re-patching — see
    // "Enforcement scope" in docs/architecture.md). The class fix is CDP-layer
    // enforcement (ADR-007), which the page realm cannot evade. If this test
    // ever FAILS, that limitation has changed — update docs/architecture.md and
    // this test together.
    const capturedBeforeArming = globalThis.fetch;

    await setRule(networkDenyingRule());
    expect(globalThis.fetch).not.toBe(nativeFetch); // armed: the global IS wrapped

    // The same agent-attributed call is denied through the wrapped global...
    await expect(asAgent(() => globalThis.fetch('https://example.test/x'))).rejects.toThrow(/blocked/i);
    // ...but sails through the pre-captured native reference.
    await expect(asAgent(() => capturedBeforeArming('https://example.test/x'))).resolves.toBeInstanceOf(Response);
  });
});
