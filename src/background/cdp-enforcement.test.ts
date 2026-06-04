import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { DelegationRule } from '../types/delegation';
import {
  decideFetchRequest,
  shouldEnforceTab,
  ruleHasBlockPattern,
  reconcile,
  initCdpEnforcement,
  attachTab,
  detachTab,
  reconcileTabs,
  isTabAttached,
  getAttachedTabs,
  _resetForTest,
  CDP_PROTOCOL_VERSION,
} from './cdp-enforcement';

function makeRule(overrides?: Partial<DelegationRule>): DelegationRule {
  return {
    id: 'rule-1',
    preset: 'readOnly',
    agentId: null,
    scope: { sitePatterns: [], actionRestrictions: [], timeBound: null },
    createdAt: '2026-01-01T00:00:00Z',
    isActive: true,
    ...overrides,
  };
}

/** A rule that permits network-request everywhere (fullAccess-like). */
function allowNetworkRule(): DelegationRule {
  return makeRule({
    preset: 'fullAccess',
    scope: {
      sitePatterns: [],
      actionRestrictions: [{ capability: 'network-request', action: 'allow' }],
      timeBound: null,
    },
  });
}

/** A rule carrying an explicit site block pattern — the only thing the CDP layer enforces. */
function blockPatternRule(pattern = '*.tracker.test'): DelegationRule {
  return makeRule({
    scope: { sitePatterns: [{ pattern, action: 'block' }], actionRestrictions: [], timeBound: null },
  });
}

function expiredBound() {
  return {
    durationMinutes: 60,
    grantedAt: '2026-01-01T00:00:00Z',
    expiresAt: '2026-01-01T01:00:00Z', // far in the past
  };
}

describe('decideFetchRequest', () => {
  it('passes through when no rule governs the tab (fail-open, nothing to enforce)', () => {
    expect(decideFetchRequest(null, 'https://example.com/x')).toEqual({ block: false, reason: '' });
  });

  it('does NOT block on a bare capability withhold — readOnly must not brick the page/human traffic', () => {
    // The CDP layer has no agent-vs-user attribution; honoring the
    // network-request capability withhold here would fail the page's own
    // resources and the human's navigation. Capability block stays page-realm.
    expect(decideFetchRequest(makeRule(), 'https://evil.test/exfil').block).toBe(false);
    // A page's own document/resource under the same readOnly rule must load.
    expect(decideFetchRequest(makeRule(), 'https://example.com/app.js').block).toBe(false);
  });

  it('does NOT block under a limited preset default-block (would brick the page tab-wide)', () => {
    const limited = makeRule({ preset: 'limited' });
    expect(decideFetchRequest(limited, 'https://example.com/anything').block).toBe(false);
  });

  it('blocks a URL matching an explicit site block pattern (repatch-immune domain block)', () => {
    const rule = blockPatternRule('*.tracker.test');
    expect(decideFetchRequest(rule, 'https://ads.tracker.test/beacon').block).toBe(true);
    expect(decideFetchRequest(rule, 'https://api.example.com/ok').block).toBe(false);
  });

  it('passes through when the rule permits network-request and has no block pattern', () => {
    expect(decideFetchRequest(allowNetworkRule(), 'https://api.example.com/ok').block).toBe(false);
  });

  it('does not block under an inactive or expired rule', () => {
    expect(decideFetchRequest(blockPatternRule(), 'https://x.tracker.test').block).toBe(true);
    expect(decideFetchRequest(makeRule({ isActive: false, scope: { sitePatterns: [{ pattern: '*.tracker.test', action: 'block' }], actionRestrictions: [], timeBound: null } }), 'https://x.tracker.test').block).toBe(false);
  });

  it('fails OPEN (passes through) if evaluation throws — a policy bug must never hang a request', () => {
    const malformed = { isActive: true, scope: null } as unknown as DelegationRule;
    expect(decideFetchRequest(malformed, 'https://example.com').block).toBe(false);
  });
});

describe('ruleHasBlockPattern', () => {
  it('is true only when a site block pattern is present', () => {
    expect(ruleHasBlockPattern(null)).toBe(false);
    expect(ruleHasBlockPattern(makeRule())).toBe(false);
    expect(ruleHasBlockPattern(allowNetworkRule())).toBe(false);
    expect(ruleHasBlockPattern(blockPatternRule())).toBe(true);
  });
});

describe('shouldEnforceTab', () => {
  const base = { settingEnabled: true, hasAgent: true, rule: blockPatternRule() };

  it('enforces when on, an agent is present, an active rule governs the tab, and it has a block pattern', () => {
    expect(shouldEnforceTab(base)).toBe(true);
  });

  it('does not enforce when the feature is off (preserves the zero-banner default)', () => {
    expect(shouldEnforceTab({ ...base, settingEnabled: false })).toBe(false);
  });

  it('does not enforce when no agent is present', () => {
    expect(shouldEnforceTab({ ...base, hasAgent: false })).toBe(false);
  });

  it('does not enforce when there is no delegation rule', () => {
    expect(shouldEnforceTab({ ...base, rule: null })).toBe(false);
  });

  it('does not enforce when the rule has no block pattern (nothing to enforce -> no banner)', () => {
    expect(shouldEnforceTab({ ...base, rule: makeRule() })).toBe(false);
  });

  it('does not enforce under an inactive rule', () => {
    expect(shouldEnforceTab({ ...base, rule: makeRule({ isActive: false }) })).toBe(false);
  });

  it('does not enforce under an expired rule', () => {
    expect(
      shouldEnforceTab({
        ...base,
        rule: makeRule({ scope: { sitePatterns: [{ pattern: '*.tracker.test', action: 'block' }], actionRestrictions: [], timeBound: expiredBound() } }),
      }),
    ).toBe(false);
  });
});

describe('reconcile', () => {
  it('attaches newly-desired tabs and detaches no-longer-desired tabs', () => {
    const { toAttach, toDetach } = reconcile(new Set([1, 2, 3]), [2, 3, 4]);
    expect(toAttach.sort()).toEqual([1]);
    expect(toDetach.sort()).toEqual([4]);
  });

  it('is a no-op when desired equals attached', () => {
    const { toAttach, toDetach } = reconcile(new Set([1, 2]), [1, 2]);
    expect(toAttach).toEqual([]);
    expect(toDetach).toEqual([]);
  });
});

// --- Orchestration against a stubbed chrome.debugger -----------------------

function createEventMock() {
  const listeners: Array<(...args: unknown[]) => void> = [];
  return {
    addListener: vi.fn((fn: (...args: unknown[]) => void) => { listeners.push(fn); }),
    _fire: (...args: unknown[]) => { for (const fn of listeners) fn(...args); },
  };
}

describe('CDP enforcement orchestration', () => {
  let attach: ReturnType<typeof vi.fn>;
  let detach: ReturnType<typeof vi.fn>;
  let sendCommand: ReturnType<typeof vi.fn>;
  let onEvent: ReturnType<typeof createEventMock>;
  let onDetach: ReturnType<typeof createEventMock>;

  beforeEach(() => {
    _resetForTest();
    attach = vi.fn(() => Promise.resolve());
    detach = vi.fn(() => Promise.resolve());
    sendCommand = vi.fn(() => Promise.resolve({}));
    onEvent = createEventMock();
    onDetach = createEventMock();
    vi.stubGlobal('chrome', {
      debugger: { attach, detach, sendCommand, onEvent, onDetach },
      runtime: { lastError: null, id: 'self' },
    });
  });

  afterEach(() => {
    _resetForTest();
    // unstubAllGlobals (not restoreAllMocks) is what reverts vi.stubGlobal —
    // otherwise the stubbed `chrome` can leak into later test files and flake them.
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('attachTab attaches at the pinned protocol version and enables the Fetch domain', async () => {
    const ok = await attachTab(42);
    expect(ok).toBe(true);
    expect(attach).toHaveBeenCalledWith({ tabId: 42 }, CDP_PROTOCOL_VERSION);
    expect(sendCommand).toHaveBeenCalledWith({ tabId: 42 }, 'Fetch.enable', {});
    expect(isTabAttached(42)).toBe(true);
  });

  it('attachTab fails safe: a rejected attach() leaves the tab unattached and detaches any partial session', async () => {
    attach.mockRejectedValueOnce(new Error('Another debugger is already attached'));
    const ok = await attachTab(7);
    expect(ok).toBe(false);
    expect(isTabAttached(7)).toBe(false);
    expect(detach).toHaveBeenCalledWith({ tabId: 7 });
  });

  it('detachTab detaches an attached tab and clears it from the set', async () => {
    await attachTab(5);
    await detachTab(5);
    expect(detach).toHaveBeenCalledWith({ tabId: 5 });
    expect(isTabAttached(5)).toBe(false);
  });

  it('reconcileTabs converges the attached set to the desired set', async () => {
    await attachTab(1);
    await attachTab(2);
    await reconcileTabs(new Set([2, 3]));
    expect(getAttachedTabs().sort()).toEqual([2, 3]);
  });

  it('blocks a paused request matching a site block pattern (Fetch.failRequest)', async () => {
    initCdpEnforcement({ getRuleForTab: () => blockPatternRule('*.tracker.test') });
    await attachTab(9);
    sendCommand.mockClear();
    onEvent._fire(
      { tabId: 9 },
      'Fetch.requestPaused',
      { requestId: 'r1', request: { url: 'https://ads.tracker.test/beacon', method: 'POST' } },
    );
    await Promise.resolve();
    expect(sendCommand).toHaveBeenCalledWith(
      { tabId: 9 },
      'Fetch.failRequest',
      { requestId: 'r1', errorReason: 'BlockedByClient' },
    );
  });

  it('continues a page-resource request under a readOnly rule (no capability-block brick)', async () => {
    initCdpEnforcement({ getRuleForTab: () => makeRule() }); // readOnly, no block pattern
    await attachTab(10);
    sendCommand.mockClear();
    onEvent._fire(
      { tabId: 10 },
      'Fetch.requestPaused',
      { requestId: 'r2', request: { url: 'https://example.com/app.js', method: 'GET' } },
    );
    await Promise.resolve();
    expect(sendCommand).toHaveBeenCalledWith({ tabId: 10 }, 'Fetch.continueRequest', { requestId: 'r2' });
    expect(sendCommand).not.toHaveBeenCalledWith({ tabId: 10 }, 'Fetch.failRequest', expect.anything());
  });

  it('continues a request that does not match any block pattern (Fetch.continueRequest)', async () => {
    initCdpEnforcement({ getRuleForTab: () => blockPatternRule('*.tracker.test') });
    await attachTab(13);
    sendCommand.mockClear();
    onEvent._fire(
      { tabId: 13 },
      'Fetch.requestPaused',
      { requestId: 'r5', request: { url: 'https://api.example.com/ok', method: 'GET' } },
    );
    await Promise.resolve();
    expect(sendCommand).toHaveBeenCalledWith({ tabId: 13 }, 'Fetch.continueRequest', { requestId: 'r5' });
  });

  it('invokes the onBlock reporter when a request is blocked', async () => {
    const onBlock = vi.fn();
    initCdpEnforcement({ getRuleForTab: () => blockPatternRule('*.x.test'), onBlock });
    await attachTab(11);
    onEvent._fire({ tabId: 11 }, 'Fetch.requestPaused', { requestId: 'r3', request: { url: 'https://a.x.test/y' } });
    await Promise.resolve();
    expect(onBlock).toHaveBeenCalledWith(11, 'https://a.x.test/y', expect.any(String));
  });

  it('releases (never blocks) a paused request for a tab we are not enforcing', async () => {
    initCdpEnforcement({ getRuleForTab: () => blockPatternRule() });
    // Tab 99 was never attached.
    onEvent._fire({ tabId: 99 }, 'Fetch.requestPaused', { requestId: 'r4', request: { url: 'https://a.tracker.test' } });
    await Promise.resolve();
    expect(sendCommand).toHaveBeenCalledWith({ tabId: 99 }, 'Fetch.continueRequest', { requestId: 'r4' });
    expect(sendCommand).not.toHaveBeenCalledWith(
      { tabId: 99 },
      'Fetch.failRequest',
      expect.anything(),
    );
  });

  it('a concurrent double-attach for one tab attaches once and keeps the set consistent with reality', async () => {
    // Both calls pass the has()-guard before either resolves; the in-flight
    // guard must stop the second from racing a second chrome.debugger.attach
    // whose catch would detach the first call's live session.
    const [a, b] = await Promise.all([attachTab(50), attachTab(50)]);
    expect([a, b].filter(Boolean).length).toBeGreaterThanOrEqual(1);
    expect(attach).toHaveBeenCalledTimes(1);
    expect(detach).not.toHaveBeenCalled();
    expect(isTabAttached(50)).toBe(true);
  });

  it('onDetach drops the tab so enforcement falls back to the page realm', async () => {
    initCdpEnforcement({ getRuleForTab: () => makeRule() });
    await attachTab(12);
    expect(isTabAttached(12)).toBe(true);
    onDetach._fire({ tabId: 12 }, 'target_closed');
    expect(isTabAttached(12)).toBe(false);
  });
});
