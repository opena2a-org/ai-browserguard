/**
 * @vitest-environment jsdom
 *
 * DOM-level enforcement test for `modify-dom` (#29 enforcement item 3).
 *
 * The MAIN-world interceptor wraps the principal DOM-write sinks
 * (`innerHTML`/`outerHTML` setters, `insertAdjacentHTML`, `setHTMLUnsafe`,
 * `document.write`/`writeln`, `setAttribute`/`setAttributeNS`) and gates each on
 * the same agent-attribution probe the navigation/form sinks use. Under an active
 * delegation that denies `modify-dom`, an agent-attributed write is dropped; the
 * user's own page scripts (which carry no CDP stack signature) always pass
 * through, so enforcing this capability cannot break the page.
 *
 * Agent attribution is simulated by invoking a write from inside a function
 * named `UtilityScript` — that name is one of the CDP stack patterns
 * `probeCallStack()` matches (Playwright's injected utility script), so the
 * V8 stack of the wrapped call resolves as agent-initiated without needing a
 * real CDP connection.
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { MSG_BRIDGE_BOOTSTRAP, MSG_RULE_UPDATE, MSG_KILL_SWITCH } from './bridge-protocol';

interface TestRule {
  isActive: boolean;
  expiresAt: string | null;
  actionRestrictions: Array<{ capability: string; action: 'allow' | 'block' }>;
  sitePatterns: Array<{ pattern: string; action: 'allow' | 'block' }>;
}

let isModifyDomGuardArmed: (rule: TestRule | null, killSwitch: boolean) => boolean;
/** ISOLATED-side port: post rule/kill-switch updates to the interceptor through this. */
let toInterceptor: MessagePort;

/** Run a callback from inside a frame named like a CDP utility script. */
function asAgent<T>(fn: () => T): T {
  // Named function expression — the name appears in the V8 call stack.
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

function blockingRule(): TestRule {
  // No restriction entry for modify-dom → isActionAllowed denies it
  // ("capability not permitted"), and any active rule arms the guard.
  return { isActive: true, expiresAt: null, actionRestrictions: [], sitePatterns: [] };
}

function allowingRule(): TestRule {
  return {
    isActive: true,
    expiresAt: null,
    actionRestrictions: [{ capability: 'modify-dom', action: 'allow' }],
    sitePatterns: [],
  };
}

beforeAll(async () => {
  // The interceptor only installs its wrappers on a secure context.
  Object.defineProperty(globalThis, 'isSecureContext', { value: true, configurable: true });

  const mod = await import('./interceptor');
  isModifyDomGuardArmed = mod.isModifyDomGuardArmed as typeof isModifyDomGuardArmed;

  // Complete the MAIN-world bridge handshake the way the ISOLATED world does:
  // transfer port2 to the interceptor via a one-shot window 'message' with the
  // bootstrap envelope, and keep port1 to drive rule/kill-switch updates.
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

describe('isModifyDomGuardArmed (pure)', () => {
  it('is armed when the kill switch is active, regardless of rule', () => {
    expect(isModifyDomGuardArmed(null, true)).toBe(true);
  });

  it('is armed when any rule is active', () => {
    expect(isModifyDomGuardArmed(blockingRule(), false)).toBe(true);
    expect(isModifyDomGuardArmed(allowingRule(), false)).toBe(true);
  });

  it('is NOT armed without a rule or kill switch (zero-cost pass-through)', () => {
    expect(isModifyDomGuardArmed(null, false)).toBe(false);
    expect(isModifyDomGuardArmed({ ...blockingRule(), isActive: false }, false)).toBe(false);
  });
});

describe('modify-dom enforcement (DOM)', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('drops an agent-attributed innerHTML write under a blocking rule', async () => {
    await setRule(blockingRule());
    const el = document.createElement('div');
    document.body.appendChild(el);

    asAgent(() => { el.innerHTML = '<span id="injected">x</span>'; });

    expect(el.innerHTML).toBe('');
    expect(el.querySelector('#injected')).toBeNull();
  });

  it('lets the user\'s own (non-agent) innerHTML write through under the same rule', async () => {
    await setRule(blockingRule());
    const el = document.createElement('div');
    document.body.appendChild(el);

    // Plain call — no CDP signature in the stack → treated as user/page write.
    el.innerHTML = '<span id="user">ok</span>';

    expect(el.querySelector('#user')).not.toBeNull();
  });

  it('lets an agent write through when the rule allows modify-dom', async () => {
    await setRule(allowingRule());
    const el = document.createElement('div');
    document.body.appendChild(el);

    asAgent(() => { el.innerHTML = '<span id="ok">y</span>'; });

    expect(el.querySelector('#ok')).not.toBeNull();
  });

  it('lets an agent write through when there is no delegation (unarmed)', async () => {
    await setRule(null);
    const el = document.createElement('div');
    document.body.appendChild(el);

    asAgent(() => { el.innerHTML = '<span id="free">z</span>'; });

    expect(el.querySelector('#free')).not.toBeNull();
  });

  it('drops an agent-attributed outerHTML write under a blocking rule', async () => {
    await setRule(blockingRule());
    const el = document.createElement('div');
    el.id = 'host';
    document.body.appendChild(el);

    asAgent(() => { el.outerHTML = '<section id="replaced"></section>'; });

    expect(document.getElementById('replaced')).toBeNull();
    expect(document.getElementById('host')).not.toBeNull(); // original element untouched
  });

  it('drops an agent-attributed document.write under a blocking rule', async () => {
    await setRule(blockingRule());
    const marker = document.createElement('div');
    marker.id = 'preserved';
    document.body.appendChild(marker);

    // A real document.write here would clear the document; the block must no-op it.
    asAgent(() => { document.write('<p id="written">x</p>'); });

    expect(document.getElementById('written')).toBeNull();
    expect(document.getElementById('preserved')).not.toBeNull(); // document not wiped
  });

  it('drops an agent-attributed insertAdjacentHTML under a blocking rule', async () => {
    await setRule(blockingRule());
    const el = document.createElement('div');
    document.body.appendChild(el);

    asAgent(() => { el.insertAdjacentHTML('beforeend', '<b id="adj">a</b>'); });

    expect(el.querySelector('#adj')).toBeNull();
  });

  it('drops an agent-attributed setAttribute under a blocking rule (injection attr)', async () => {
    await setRule(blockingRule());
    const el = document.createElement('a');
    document.body.appendChild(el);

    asAgent(() => { el.setAttribute('href', 'javascript:alert(1)'); });

    expect(el.getAttribute('href')).toBeNull();
  });

  it('drops an agent-attributed setAttribute for any attribute (modify-dom is general DOM mutation)', async () => {
    await setRule(blockingRule());
    const el = document.createElement('div');
    document.body.appendChild(el);

    asAgent(() => { el.setAttribute('data-agent', 'touched'); });

    expect(el.getAttribute('data-agent')).toBeNull();
  });

  it('drops an agent-attributed setAttributeNS (the obvious setAttribute sibling-bypass)', async () => {
    await setRule(blockingRule());
    const el = document.createElement('div');
    document.body.appendChild(el);

    asAgent(() => {
      el.setAttributeNS('http://www.w3.org/1999/xlink', 'xlink:href', 'javascript:alert(1)');
    });

    expect(el.getAttributeNS('http://www.w3.org/1999/xlink', 'href')).toBeNull();
  });

  it('blocks every agent-attributed write while the kill switch is active', async () => {
    await setRule(allowingRule()); // even an allowing rule is overridden
    await setKillSwitch(true);
    const el = document.createElement('div');
    document.body.appendChild(el);

    asAgent(() => { el.innerHTML = '<span id="ks">k</span>'; });
    expect(el.querySelector('#ks')).toBeNull();

    // The user's own write is still NOT blocked, even during the kill switch.
    el.innerHTML = '<span id="ks-user">u</span>';
    expect(el.querySelector('#ks-user')).not.toBeNull();

    await setKillSwitch(false); // restore for any later tests
  });
});
