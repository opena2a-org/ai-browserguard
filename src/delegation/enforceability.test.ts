/**
 * Enforceability contract for detected agents (ADR-007 / ADR-008).
 *
 * Regression guard: the v0.4.2 popup rendered "Managed" and a "Read-Only" grant
 * for external CDP frameworks (Playwright/Cowork) it cannot enforce against.
 * These tests pin the presentation to the agent's actual enforceability so the
 * incorrect label cannot return.
 */
import { describe, it, expect } from 'vitest';
import {
  isExternalDriver,
  enforcementReality,
  nativeInputObservable,
  presentAgent,
  downloadsEnforced,
  EXTERNAL_DRIVER_DOWNLOADS_ENFORCED_LABEL,
  type AgentLike,
} from './enforceability';
import { createRuleFromPreset } from './rules';
import type { DelegationRule } from '../types/delegation';
import type { AgentType, DetectionMethod } from '../types/agent';

const agent = (type: AgentType, detectionMethods: DetectionMethod[]): AgentLike => ({ type, detectionMethods });
const READ_ONLY = { preset: 'readOnly', isActive: true } as unknown as DelegationRule;

describe('isExternalDriver', () => {
  it('is true for every known external framework type', () => {
    for (const t of ['playwright', 'puppeteer', 'selenium', 'anthropic-computer-use', 'openai-operator', 'cdp-generic', 'webdriver-generic'] as AgentType[]) {
      expect(isExternalDriver(agent(t, []))).toBe(true);
    }
  });

  it('is true for unknown-type agents with any external-driver or native-input signal, or no signal', () => {
    expect(isExternalDriver(agent('unknown', ['cdp-connection']))).toBe(true);
    expect(isExternalDriver(agent('unknown', ['webdriver-flag']))).toBe(true);
    expect(isExternalDriver(agent('unknown', ['automation-flag']))).toBe(true);
    // behavioural methods are inferred from NATIVE input -> not observable -> external
    expect(isExternalDriver(agent('unknown', ['behavioral-timing']))).toBe(true);
    expect(isExternalDriver(agent('unknown', ['behavioral-typing']))).toBe(true);
    // no evidence at all -> fail safe to external
    expect(isExternalDriver(agent('unknown', []))).toBe(true);
    // a page-realm signal mixed with a non-page-realm one is still external
    expect(isExternalDriver(agent('unknown', ['synthetic-event', 'cdp-connection']))).toBe(true);
  });

  it('is false only for unknown-type agents whose signals are all page-realm', () => {
    expect(isExternalDriver(agent('unknown', ['synthetic-event']))).toBe(false);
    expect(isExternalDriver(agent('unknown', ['framework-fingerprint']))).toBe(false);
    expect(isExternalDriver(agent('unknown', ['synthetic-event', 'framework-fingerprint']))).toBe(false);
  });
});

describe('enforcementReality / nativeInputObservable', () => {
  it('reports none + unobservable for external drivers', () => {
    const a = agent('playwright', ['cdp-connection']);
    expect(enforcementReality(a)).toBe('none');
    expect(nativeInputObservable(a)).toBe(false);
  });
  it('reports page-realm-best-effort + observable for in-page agents', () => {
    const a = agent('unknown', ['synthetic-event']);
    expect(enforcementReality(a)).toBe('page-realm-best-effort');
    expect(nativeInputObservable(a)).toBe(true);
  });
});

describe('presentAgent — the enforceability contract', () => {
  it('regression: an external driver under a Read-Only rule is NEVER "Managed" and is not enforceable', () => {
    const p = presentAgent(agent('playwright', ['cdp-connection']), createRuleFromPreset('readOnly'));
    expect(p.enforceable).toBe(false);
    expect(p.badge).not.toMatch(/Managed/);
    // No session of ours on its tab: no download can be tied to this agent, so nothing is enforced.
    expect(p.badge).toBe('Monitor only');
    expect(p.ruleCaveat).toBeTruthy();
    expect(p.ruleCaveat).toMatch(/kill switch/i);
  });

  it('external driver with no rule still shows monitor-only, no caveat', () => {
    const p = presentAgent(agent('cdp-generic', ['cdp-connection']), null);
    expect(p.enforceable).toBe(false);
    expect(p.badge).toBe('Monitor only');
    expect(p.ruleCaveat).toBeNull();
  });

  it('in-page agent under a rule may be best-effort managed (best-effort qualifier present)', () => {
    const p = presentAgent(agent('unknown', ['synthetic-event']), READ_ONLY);
    expect(p.enforceable).toBe(true);
    expect(p.badge).toMatch(/best-effort/i);
  });

  it('in-page agent with no rule is just "Detected"', () => {
    const p = presentAgent(agent('unknown', ['synthetic-event']), null);
    expect(p.badge).toBe('Detected');
  });
});

describe('presentAgent — external-driver downloads (#69, one predicate for pill and caveat)', () => {
  const driverOn = (originUrl: string): AgentLike => ({
    type: 'anthropic-computer-use',
    detectionMethods: ['cdp-connection'],
    originUrl,
  });
  const WATCHED = { downloadsWatched: true };
  const VARIANT_B =
    'Page-level policy does not stop this agent: it drives the browser directly. The kill switch (close tab) is the hard stop.';

  it('Read-Only on a watched agent tab: downloads started in that tab are cancelled, stated with the host', () => {
    const a = driverOn('https://shop.example.com/cart');
    const rule = createRuleFromPreset('readOnly');
    const p = presentAgent(a, rule, WATCHED);
    expect(downloadsEnforced(a, rule, WATCHED)).toBe(true);
    expect(p.enforceable).toBe(false);
    expect(p.badge).toBe(EXTERNAL_DRIVER_DOWNLOADS_ENFORCED_LABEL);
    expect(p.ruleCaveat).toBe(
      "Page-level policy does not stop this agent: it drives the browser directly. Under this delegation, downloads started in this agent's tab (detected on shop.example.com) are cancelled, yours included. The kill switch (close tab) is the hard stop.",
    );
  });

  it('Read-Only with no session of ours on the agent tab: nothing ties a download to it, so "Monitor only"', () => {
    const a = driverOn('https://shop.example.com/cart');
    const rule = createRuleFromPreset('readOnly');
    for (const tab of [undefined, {}, { downloadsWatched: false }]) {
      expect(downloadsEnforced(a, rule, tab)).toBe(false);
      const p = presentAgent(a, rule, tab);
      expect(p.badge).toBe('Monitor only');
      expect(p.ruleCaveat).toBe(VARIANT_B);
    }
  });

  it('Limited blocks downloads too', () => {
    const a = driverOn('https://shop.example.com/');
    const rule = createRuleFromPreset('limited');
    expect(downloadsEnforced(a, rule, WATCHED)).toBe(true);
    expect(presentAgent(a, rule, WATCHED).badge).toBe(EXTERNAL_DRIVER_DOWNLOADS_ENFORCED_LABEL);
  });

  it('Full Access permits downloads: the short caveat and "Monitor only"', () => {
    const a = driverOn('https://shop.example.com/');
    const rule = createRuleFromPreset('fullAccess');
    const p = presentAgent(a, rule, WATCHED);
    expect(downloadsEnforced(a, rule, WATCHED)).toBe(false);
    expect(p.badge).toBe('Monitor only');
    expect(p.ruleCaveat).toBe(VARIANT_B);
  });

  it('a host-less origin (about:blank, file://) on a watched tab: downloads in the tab are still cancelled, stated without a host', () => {
    for (const origin of ['about:blank', 'file:///Users/me/page.html', '']) {
      const a = driverOn(origin);
      const rule = createRuleFromPreset('readOnly');
      const p = presentAgent(a, rule, WATCHED);
      expect(downloadsEnforced(a, rule, WATCHED)).toBe(true);
      expect(p.badge).toBe(EXTERNAL_DRIVER_DOWNLOADS_ENFORCED_LABEL);
      expect(p.ruleCaveat).toBe(
        "Page-level policy does not stop this agent: it drives the browser directly. Under this delegation, downloads started in this agent's tab are cancelled, yours included. The kill switch (close tab) is the hard stop.",
      );
    }
  });

  it('no rule: "Monitor only" and no caveat', () => {
    const a = driverOn('https://shop.example.com/');
    expect(downloadsEnforced(a, null, WATCHED)).toBe(false);
    const p = presentAgent(a, null, WATCHED);
    expect(p.badge).toBe('Monitor only');
    expect(p.ruleCaveat).toBeNull();
  });

  it('the pill shows the downloads state exactly when the caveat says downloads are cancelled', () => {
    const cases: Array<[string, DelegationRule | null, boolean]> = [
      ['https://a.example/', createRuleFromPreset('readOnly'), true],
      ['https://a.example/', createRuleFromPreset('readOnly'), false],
      ['https://a.example/', createRuleFromPreset('limited'), true],
      ['https://a.example/', createRuleFromPreset('fullAccess'), true],
      ['https://a.example/', null, true],
      ['about:blank', createRuleFromPreset('readOnly'), true],
      ['about:blank', createRuleFromPreset('readOnly'), false],
    ];
    for (const [origin, rule, downloadsWatched] of cases) {
      const p = presentAgent(driverOn(origin), rule, { downloadsWatched });
      const saysCancelled = (p.ruleCaveat ?? '').includes("downloads started in this agent's tab");
      expect(p.badge === EXTERNAL_DRIVER_DOWNLOADS_ENFORCED_LABEL).toBe(saysCancelled);
    }
  });

  it('the tooltip no longer says every action is unblockable', () => {
    const p = presentAgent(driverOn('https://a.example/'), createRuleFromPreset('readOnly'));
    expect(p.badgeTitle).toContain('cannot block the actions it takes in the page');
    expect(p.badgeTitle).not.toMatch(/individual actions/);
  });
});
