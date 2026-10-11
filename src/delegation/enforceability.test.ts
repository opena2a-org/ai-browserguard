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
  type BrowserLayerState,
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

describe('presentAgent — what Browser-layer blocking is doing in the tab (#110)', () => {
  const inPage = agent('unknown', ['synthetic-event']);
  const driver = agent('playwright', ['cdp-connection']);
  const withBlockedSite = (rule: DelegationRule): DelegationRule => ({
    ...rule,
    scope: { ...rule.scope, sitePatterns: [{ pattern: 'blocked.example', action: 'block' }] },
  });
  // Read-Only as the wizard creates it: it blocks downloads and no site, and
  // still gets a session, to report the downloads started in the tab.
  const readOnly = createRuleFromPreset('readOnly');
  const readOnlyWithSite = withBlockedSite(readOnly);
  const fullAccess = createRuleFromPreset('fullAccess');
  const fullAccessWithSite = withBlockedSite(fullAccess);
  const REFUSED: BrowserLayerState = {
    state: 'unavailable',
    cause: 'attach-failed',
    detail: 'Another debugger is already attached to the tab with id: 7.',
  };
  const ATTACHED: BrowserLayerState = { state: 'attached' };
  const BANNER_AND_END =
    ' That is why Chrome shows its "debugging this browser" banner. It detaches when the delegation or the agent\'s session ends, the tab closes, or the setting is turned off.';

  it('says nothing for a tab the layer does not apply to', () => {
    expect(presentAgent(inPage, readOnly).browserLayerNote).toBeNull();
    expect(presentAgent(driver, readOnly, { downloadsWatched: true }).browserLayerNote).toBeNull();
  });

  it('attached under a delegation that blocks no site: says the session is there for downloads, and names no site', () => {
    for (const a of [inPage, driver]) {
      const note = presentAgent(a, readOnly, { downloadsWatched: true, browserLayer: ATTACHED }).browserLayerNote;
      expect(note).toEqual({
        kind: 'active',
        text: `Browser-layer blocking is attached to this tab to cancel downloads started in it.${BANNER_AND_END}`,
      });
      expect(note!.text).not.toContain('sites');
    }
  });

  it('attached under a delegation that blocks a site and downloads: names both', () => {
    for (const a of [inPage, driver]) {
      const note = presentAgent(a, readOnlyWithSite, { downloadsWatched: true, browserLayer: ATTACHED }).browserLayerNote;
      expect(note).toEqual({
        kind: 'active',
        text: `Browser-layer blocking is attached to this tab to enforce the sites your delegation blocks and to cancel downloads started in it.${BANNER_AND_END}`,
      });
    }
  });

  it('attached under a delegation that blocks a site and permits downloads: names the sites only', () => {
    const note = presentAgent(inPage, fullAccessWithSite, { downloadsWatched: true, browserLayer: ATTACHED }).browserLayerNote;
    expect(note!.text).toBe(
      `Browser-layer blocking is attached to this tab to enforce the sites your delegation blocks.${BANNER_AND_END}`,
    );
    expect(note!.text).not.toContain('downloads');
  });

  it('attached to a tab whose downloads are not cancelled: claims no cancellation', () => {
    // The pill reads the same input, so the note and the pill cannot disagree.
    expect(presentAgent(driver, readOnly, { browserLayer: ATTACHED }).browserLayerNote!.text).toBe(
      `Browser-layer blocking is attached to this tab.${BANNER_AND_END}`,
    );
    expect(presentAgent(driver, readOnlyWithSite, { downloadsWatched: false, browserLayer: ATTACHED }).browserLayerNote!.text).toBe(
      `Browser-layer blocking is attached to this tab to enforce the sites your delegation blocks.${BANNER_AND_END}`,
    );
  });

  it('refused attach, in-page agent: quotes Chrome, names what is not enforced, and the page-level fallback', () => {
    const note = presentAgent(inPage, readOnlyWithSite, { browserLayer: REFUSED }).browserLayerNote;
    expect(note).toEqual({
      kind: 'unavailable',
      text: 'Browser-layer blocking could not attach to this tab. Chrome reported: Another debugger is already attached to the tab with id: 7. Until it attaches, the sites your delegation blocks are not enforced at the browser layer on this tab, and downloads started in it are not cancelled. Page-level enforcement still applies on a best-effort basis. AI Browser Guard retries automatically.',
    });
  });

  it('refused attach under a delegation that blocks no site: names downloads only, and no page-level fallback for them', () => {
    const note = presentAgent(inPage, readOnly, { browserLayer: REFUSED }).browserLayerNote;
    expect(note).toEqual({
      kind: 'unavailable',
      text: "Browser-layer blocking could not attach to this tab. Chrome reported: Another debugger is already attached to the tab with id: 7. Until it attaches, downloads started in this tab are not cancelled. Page-level enforcement of the agent's other actions still applies on a best-effort basis. AI Browser Guard retries automatically.",
    });
    expect(note!.text).not.toContain('sites');
  });

  it('refused attach, external driver: never claims a page-level fallback that does not stop it', () => {
    const text = presentAgent(driver, readOnlyWithSite, { browserLayer: REFUSED }).browserLayerNote!.text;
    expect(text).toContain('Page-level policy does not stop this agent, so those sites are not blocked for it here.');
    expect(text).not.toContain('Page-level enforcement');

    const noSite = presentAgent(driver, readOnly, { browserLayer: REFUSED }).browserLayerNote!.text;
    expect(noSite).toContain(
      'Until it attaches, downloads started in this tab are not cancelled. Page-level policy does not stop this agent. AI Browser Guard retries automatically.',
    );
    expect(noSite).not.toContain('sites');
    expect(noSite).not.toContain('Page-level enforcement');
  });

  it('mentions downloads only under a delegation that blocks them', () => {
    expect(presentAgent(inPage, readOnlyWithSite, { browserLayer: REFUSED }).browserLayerNote!.text).toContain('downloads started in it are not cancelled');
    expect(presentAgent(inPage, fullAccessWithSite, { browserLayer: REFUSED }).browserLayerNote!.text).not.toContain('downloads');
  });

  it('a delegation that gives the session nothing to do: says only that it could not attach', () => {
    expect(presentAgent(inPage, fullAccess, { browserLayer: REFUSED }).browserLayerNote!.text).toBe(
      'Browser-layer blocking could not attach to this tab. Chrome reported: Another debugger is already attached to the tab with id: 7. AI Browser Guard retries automatically.',
    );
  });

  it('refused attach with no text from Chrome: states the refusal alone, and ends an unpunctuated one', () => {
    const bare = presentAgent(inPage, readOnly, { browserLayer: { state: 'unavailable', cause: 'attach-failed', detail: '' } });
    expect(bare.browserLayerNote!.text).toMatch(/^Browser-layer blocking could not attach to this tab\. Until it attaches, /);
    const unpunctuated = presentAgent(inPage, readOnly, { browserLayer: { state: 'unavailable', cause: 'attach-failed', detail: 'Not allowed' } });
    expect(unpunctuated.browserLayerNote!.text).toContain('Chrome reported: Not allowed. Until it attaches, ');
  });

  it('session ended by Chrome: says so, with the reason when it is one Chrome documents', () => {
    const ended = (detail?: string) =>
      presentAgent(inPage, readOnly, { browserLayer: { state: 'unavailable', cause: 'detached', detail } }).browserLayerNote!;
    expect(ended('canceled_by_user').text).toMatch(/^Chrome ended Browser-layer blocking's debugger session on this tab when its debugging banner was cancelled\. Until it attaches, /);
    expect(ended('target_closed').text).toMatch(/^Chrome ended Browser-layer blocking's debugger session on this tab when the page it was attached to closed\. /);
    expect(ended('some_future_reason').text).toMatch(/^Chrome ended Browser-layer blocking's debugger session on this tab\. /);
    expect(ended().text).toMatch(/^Chrome ended Browser-layer blocking's debugger session on this tab\. /);
    expect(ended('canceled_by_user').kind).toBe('unavailable');
  });

  it('says nothing without a rule, or for a state it does not know', () => {
    expect(presentAgent(inPage, null, { browserLayer: { state: 'attached' } }).browserLayerNote).toBeNull();
    expect(presentAgent(driver, null, { browserLayer: REFUSED }).browserLayerNote).toBeNull();
    const unknown = { state: 'paused' } as unknown as BrowserLayerState;
    expect(presentAgent(inPage, readOnly, { browserLayer: unknown }).browserLayerNote).toBeNull();
  });

  it('leaves the pill and the caveat as they were', () => {
    const without = presentAgent(driver, readOnly, { downloadsWatched: true });
    const withNote = presentAgent(driver, readOnly, { downloadsWatched: true, browserLayer: ATTACHED });
    expect({ ...withNote, browserLayerNote: null }).toEqual(without);
  });
});
