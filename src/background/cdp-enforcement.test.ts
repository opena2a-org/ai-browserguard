import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { DelegationRule } from '../types/delegation';
import {
  decideFetchRequest,
  shouldEnforceTab,
  ruleHasBlockPattern,
  ruleWithholdsDownloads,
  reconcile,
  initCdpEnforcement,
  attachTab,
  detachTab,
  reconcileTabs,
  isTabAttached,
  getAttachedTabs,
  getTabEnforcementFault,
  _resetForTest,
  CDP_PROTOCOL_VERSION,
  TAB_DOWNLOAD_START_GRACE_MS,
  takeTabDownloadStart,
  awaitTabDownloadStart,
  isTabDownloadWatched,
} from './cdp-enforcement';
import { TAB_DOWNLOAD_START_CANDIDATE_MS, TAB_DOWNLOAD_START_WINDOW_MS } from './download-monitor';

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

/** A rule that permits downloads and blocks no site: nothing for a session to do. */
function allowDownloadsRule(): DelegationRule {
  return makeRule({
    preset: 'fullAccess',
    scope: {
      sitePatterns: [],
      actionRestrictions: [{ capability: 'download-file', action: 'allow' }],
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

describe('ruleWithholdsDownloads', () => {
  it('is true when download-file is blocked or unlisted, false when it is allowed', () => {
    expect(ruleWithholdsDownloads(null)).toBe(false);
    expect(ruleWithholdsDownloads(makeRule())).toBe(true); // unlisted -> default block
    expect(ruleWithholdsDownloads(makeRule({
      scope: { sitePatterns: [], actionRestrictions: [{ capability: 'download-file', action: 'block' }], timeBound: null },
    }))).toBe(true);
    expect(ruleWithholdsDownloads(allowDownloadsRule())).toBe(false);
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

  it('enforces a rule that withholds downloads and blocks no site (Read-Only): the session reports downloads', () => {
    expect(shouldEnforceTab({ ...base, rule: makeRule() })).toBe(true);
  });

  it('does not enforce a rule that permits downloads and blocks no site (nothing to do -> no banner)', () => {
    expect(shouldEnforceTab({ ...base, rule: allowDownloadsRule() })).toBe(false);
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

  it('attachTab attaches at the pinned protocol version and enables the Fetch domain under a blocked site', async () => {
    initCdpEnforcement({ getRuleForTab: () => blockPatternRule() });
    const ok = await attachTab(42);
    expect(ok).toBe(true);
    expect(attach).toHaveBeenCalledWith({ tabId: 42 }, CDP_PROTOCOL_VERSION);
    expect(sendCommand).toHaveBeenCalledWith({ tabId: 42 }, 'Fetch.enable', {});
    expect(isTabAttached(42)).toBe(true);
  });

  it('attachTab under a rule that blocks no site (Read-Only) watches downloads and pauses no request', async () => {
    initCdpEnforcement({ getRuleForTab: () => makeRule() });
    expect(await attachTab(44)).toBe(true);
    const methods = sendCommand.mock.calls.map((c: unknown[]) => c[1]);
    expect(methods).toEqual(['Page.enable']);
    expect(isTabAttached(44)).toBe(true);
    expect(isTabDownloadWatched(44)).toBe(true);
  });

  it('reconcileTabs turns request interception on when the rule gains a blocked site, and off when it loses it', async () => {
    let rule = makeRule();
    initCdpEnforcement({ getRuleForTab: () => rule });
    await reconcileTabs(new Set([45]));
    expect(sendCommand).not.toHaveBeenCalledWith({ tabId: 45 }, 'Fetch.enable', {});

    rule = blockPatternRule();
    await reconcileTabs(new Set([45]));
    expect(sendCommand).toHaveBeenCalledWith({ tabId: 45 }, 'Fetch.enable', {});
    expect(attach).toHaveBeenCalledTimes(1); // same session, no re-attach

    sendCommand.mockClear();
    await reconcileTabs(new Set([45]));
    expect(sendCommand).not.toHaveBeenCalled(); // already in line

    rule = makeRule();
    await reconcileTabs(new Set([45]));
    expect(sendCommand).toHaveBeenCalledWith({ tabId: 45 }, 'Fetch.disable', {});
    expect(isTabAttached(45)).toBe(true);
    expect(isTabDownloadWatched(45)).toBe(true);
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
    expect(isTabDownloadWatched(12)).toBe(false);
  });
});

describe('a fallback from the CDP layer is recorded for the tab (#110)', () => {
  let attach: ReturnType<typeof vi.fn>;
  let detach: ReturnType<typeof vi.fn>;
  let sendCommand: ReturnType<typeof vi.fn>;
  let onDetach: ReturnType<typeof createEventMock>;

  beforeEach(() => {
    _resetForTest();
    attach = vi.fn(() => Promise.resolve());
    detach = vi.fn(() => Promise.resolve());
    sendCommand = vi.fn(() => Promise.resolve({}));
    onDetach = createEventMock();
    vi.stubGlobal('chrome', {
      debugger: { attach, detach, sendCommand, onEvent: createEventMock(), onDetach },
      runtime: { lastError: null, id: 'self' },
    });
    initCdpEnforcement({ getRuleForTab: () => makeRule() });
  });

  afterEach(() => {
    _resetForTest();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('a tab with a session, and a tab never attached, have nothing recorded', async () => {
    await attachTab(1);
    expect(getTabEnforcementFault(1)).toBeNull();
    expect(getTabEnforcementFault(2)).toBeNull();
  });

  it('a refused attach is recorded with the error Chrome gave', async () => {
    attach.mockRejectedValueOnce(new Error('Another debugger is already attached to the tab with id: 7.'));
    expect(await attachTab(7)).toBe(false);
    expect(getTabEnforcementFault(7)).toEqual({
      cause: 'attach-failed',
      detail: 'Another debugger is already attached to the tab with id: 7.',
      at: expect.any(Number),
    });
  });

  it('a session Chrome attached and then refused Fetch.enable on is recorded as a failed attach', async () => {
    initCdpEnforcement({ getRuleForTab: () => blockPatternRule() });
    sendCommand.mockImplementation((_t: unknown, method: string) =>
      method === 'Fetch.enable' ? Promise.reject(new Error('Not allowed')) : Promise.resolve({}));
    expect(await attachTab(8)).toBe(false);
    expect(isTabAttached(8)).toBe(false);
    expect(getTabEnforcementFault(8)).toMatchObject({ cause: 'attach-failed', detail: 'Not allowed' });
  });

  it('a session held only to report downloads that Chrome refused Page.enable on is recorded as a failed attach', async () => {
    // The rule blocks no site, so the session is dropped rather than kept for
    // nothing. The tab still warrants one, so the drop is a fallback to report.
    sendCommand.mockImplementation((_t: unknown, method: string) =>
      method === 'Page.enable' ? Promise.reject(new Error('Not allowed')) : Promise.resolve({}));
    expect(await attachTab(21)).toBe(false);
    expect(isTabAttached(21)).toBe(false);
    expect(detach).toHaveBeenCalledWith({ tabId: 21 });
    expect(getTabEnforcementFault(21)).toEqual({ cause: 'attach-failed', detail: 'Not allowed', at: expect.any(Number) });
  });

  it('a blocked-site session that Chrome refused Page.enable on stays attached, with nothing recorded', async () => {
    initCdpEnforcement({ getRuleForTab: () => blockPatternRule() });
    sendCommand.mockImplementation((_t: unknown, method: string) =>
      method === 'Page.enable' ? Promise.reject(new Error('Not allowed')) : Promise.resolve({}));
    expect(await attachTab(22)).toBe(true);
    expect(isTabAttached(22)).toBe(true);
    expect(getTabEnforcementFault(22)).toBeNull();
  });

  it('a download-only session refused once is attached by the next reconcile, which clears the record', async () => {
    sendCommand.mockImplementationOnce(() => Promise.reject(new Error('Not allowed')));
    await reconcileTabs(new Set([23]));
    expect(getTabEnforcementFault(23)).toMatchObject({ cause: 'attach-failed', detail: 'Not allowed' });
    await reconcileTabs(new Set([23]));
    expect(isTabAttached(23)).toBe(true);
    expect(getTabEnforcementFault(23)).toBeNull();
  });

  it('the error text is kept as one short line', async () => {
    attach.mockRejectedValueOnce(new Error(`first line\n  second line ${'x'.repeat(400)}`));
    await attachTab(9);
    const detail = getTabEnforcementFault(9)!.detail;
    expect(detail.startsWith('first line second line x')).toBe(true);
    expect(detail.length).toBe(160);
  });

  it('a rejection that is not an Error is recorded without text', async () => {
    attach.mockRejectedValueOnce({ code: -32000 });
    await attachTab(10);
    expect(getTabEnforcementFault(10)).toMatchObject({ cause: 'attach-failed', detail: '' });
  });

  it('with no chrome.debugger to attach through, the tab is recorded as a failed attach', async () => {
    vi.stubGlobal('chrome', { runtime: { lastError: null, id: 'self' } });
    expect(await attachTab(11)).toBe(false);
    expect(getTabEnforcementFault(11)).toMatchObject({ cause: 'attach-failed', detail: '' });
  });

  it('a session Chrome ends is recorded with the reason Chrome gave', async () => {
    await attachTab(12);
    onDetach._fire({ tabId: 12 }, 'canceled_by_user');
    expect(isTabAttached(12)).toBe(false);
    expect(getTabEnforcementFault(12)).toEqual({ cause: 'detached', detail: 'canceled_by_user', at: expect.any(Number) });
  });

  it('a detach event for a tab we hold no session on records nothing', () => {
    onDetach._fire({ tabId: 13 }, 'target_closed');
    expect(getTabEnforcementFault(13)).toBeNull();
  });

  it('detaching a tab ourselves records nothing, even when Chrome then reports the detach', async () => {
    await attachTab(14);
    await detachTab(14);
    onDetach._fire({ tabId: 14 }, 'canceled_by_user');
    expect(getTabEnforcementFault(14)).toBeNull();
  });

  it('the next attach that succeeds clears what was recorded', async () => {
    attach.mockRejectedValueOnce(new Error('Another debugger is already attached'));
    await reconcileTabs(new Set([15]));
    expect(getTabEnforcementFault(15)).toMatchObject({ cause: 'attach-failed' });
    await reconcileTabs(new Set([15]));
    expect(isTabAttached(15)).toBe(true);
    expect(getTabEnforcementFault(15)).toBeNull();
  });

  it('a retry that fails again keeps the tab recorded, with the newer error', async () => {
    attach.mockRejectedValueOnce(new Error('first'));
    await reconcileTabs(new Set([16]));
    attach.mockRejectedValueOnce(new Error('second'));
    await reconcileTabs(new Set([16]));
    expect(getTabEnforcementFault(16)).toMatchObject({ cause: 'attach-failed', detail: 'second' });
  });

  it('a session Chrome ended is attached again by the next reconcile, which clears the record', async () => {
    await reconcileTabs(new Set([17]));
    onDetach._fire({ tabId: 17 }, 'canceled_by_user');
    expect(getTabEnforcementFault(17)).toMatchObject({ cause: 'detached' });
    await reconcileTabs(new Set([17]));
    expect(attach).toHaveBeenCalledTimes(2);
    expect(getTabEnforcementFault(17)).toBeNull();
  });

  it('a reconcile that no longer wants the tab drops what was recorded for it, and keeps other tabs', async () => {
    attach.mockRejectedValue(new Error('Another debugger is already attached'));
    await reconcileTabs(new Set([18, 19]));
    expect(getTabEnforcementFault(18)).not.toBeNull();
    await reconcileTabs(new Set([19]));
    expect(getTabEnforcementFault(18)).toBeNull();
    expect(getTabEnforcementFault(19)).toMatchObject({ cause: 'attach-failed' });
    await reconcileTabs(new Set());
    expect(getTabEnforcementFault(19)).toBeNull();
  });

  it('closing a tab whose attach failed drops what was recorded for it', async () => {
    attach.mockRejectedValueOnce(new Error('Another debugger is already attached'));
    await attachTab(20);
    await detachTab(20);
    expect(getTabEnforcementFault(20)).toBeNull();
  });
});

describe('download starts reported on our sessions (Page.downloadWillBegin)', () => {
  let sendCommand: ReturnType<typeof vi.fn>;
  let onEvent: ReturnType<typeof createEventMock>;
  /** The command each watched session is sent to learn it has no start left to report. */
  const BARRIER = 'Inspector.disable';
  const item = { url: 'https://files.example.com/report.pdf' };
  const willBegin = (tabId: number, guid: string, url = item.url) =>
    onEvent._fire({ tabId }, 'Page.downloadWillBegin', { frameId: `F-${tabId}`, guid, url, suggestedFilename: 'report.pdf' });

  beforeEach(() => {
    _resetForTest();
    sendCommand = vi.fn(() => Promise.resolve({}));
    onEvent = createEventMock();
    vi.stubGlobal('chrome', {
      debugger: { attach: vi.fn(() => Promise.resolve()), detach: vi.fn(() => Promise.resolve()), sendCommand, onEvent, onDetach: createEventMock() },
      runtime: { lastError: null, id: 'self' },
    });
    initCdpEnforcement({ getRuleForTab: () => makeRule() });
  });

  afterEach(() => {
    _resetForTest();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('attachTab enables the Page domain on the same session, after Fetch', async () => {
    initCdpEnforcement({ getRuleForTab: () => blockPatternRule() });
    await attachTab(42);
    const methods = sendCommand.mock.calls.map((c: unknown[]) => c[1]);
    expect(methods).toEqual(['Fetch.enable', 'Page.enable']);
    expect(isTabDownloadWatched(42)).toBe(true);
  });

  it('a failed Page.enable keeps the blocked-site session and leaves downloads there unwatched', async () => {
    initCdpEnforcement({ getRuleForTab: () => blockPatternRule() });
    sendCommand.mockImplementation((_t: unknown, method: string) =>
      method === 'Page.enable' ? Promise.reject(new Error('not allowed')) : Promise.resolve({}));
    expect(await attachTab(43)).toBe(true);
    expect(isTabAttached(43)).toBe(true);
    expect(isTabDownloadWatched(43)).toBe(false);
  });

  it('a failed Page.enable drops a session that blocks no site: it would do nothing but show the banner', async () => {
    sendCommand.mockImplementation((_t: unknown, method: string) =>
      method === 'Page.enable' ? Promise.reject(new Error('not allowed')) : Promise.resolve({}));
    expect(await attachTab(46)).toBe(false);
    expect(isTabAttached(46)).toBe(false);
    expect(isTabDownloadWatched(46)).toBe(false);
  });

  it('a start on an attached tab is matched to its download item once', async () => {
    await attachTab(42);
    willBegin(42, 'g1');
    expect(takeTabDownloadStart(item)).toEqual(expect.objectContaining({ tabId: 42, frameId: 'F-42', guid: 'g1' }));
    expect(takeTabDownloadStart(item)).toBeNull();
  });

  it('a start reported for a tab we hold no session on is dropped', async () => {
    await attachTab(42);
    willBegin(77, 'g-other');
    expect(takeTabDownloadStart(item)).toBeNull();
  });

  it('a start older than the window is not matched', async () => {
    vi.useFakeTimers();
    await attachTab(42);
    willBegin(42, 'g1');
    vi.advanceTimersByTime(TAB_DOWNLOAD_START_WINDOW_MS + 1);
    expect(takeTabDownloadStart(item)).toBeNull();
  });

  it('a download item waits for a start reported after it, inside the window', async () => {
    await attachTab(42);
    const pending = awaitTabDownloadStart(item);
    willBegin(42, 'g-late');
    await expect(pending).resolves.toEqual(expect.objectContaining({ tabId: 42, guid: 'g-late' }));
  });

  it('a download item with no start resolves null at the end of the window', async () => {
    vi.useFakeTimers();
    await attachTab(42);
    const pending = awaitTabDownloadStart(item);
    vi.advanceTimersByTime(TAB_DOWNLOAD_START_WINDOW_MS);
    await expect(pending).resolves.toBeNull();
  });

  // #91: a download from a tab without our session is never reported, and
  // waiting out the whole window delayed its timeline entry and notice by 5 s.
  it('a download item no session reports resolves once every watched session has answered, long before the window ends', async () => {
    vi.useFakeTimers();
    await attachTab(42);
    await attachTab(43);
    let result: unknown = 'pending';
    void awaitTabDownloadStart(item).then((s) => { result = s; });
    await vi.advanceTimersByTimeAsync(TAB_DOWNLOAD_START_GRACE_MS);
    expect(result).toBeNull();
    expect(sendCommand).toHaveBeenCalledWith({ tabId: 42 }, BARRIER, {});
    expect(sendCommand).toHaveBeenCalledWith({ tabId: 43 }, BARRIER, {});
  });

  it('a session that answers does not end the wait while another watched session has not answered', async () => {
    vi.useFakeTimers();
    await attachTab(42);
    await attachTab(43);
    sendCommand.mockImplementation((target: { tabId: number }, method: string) =>
      method === BARRIER && target.tabId === 43 ? new Promise(() => {}) : Promise.resolve({}));
    let result: unknown = 'pending';
    void awaitTabDownloadStart(item).then((s) => { result = s; });
    await vi.advanceTimersByTimeAsync(TAB_DOWNLOAD_START_WINDOW_MS - 1);
    expect(sendCommand).toHaveBeenCalledWith({ tabId: 42 }, BARRIER, {});
    expect(result).toBe('pending');
    await vi.advanceTimersByTimeAsync(1);
    expect(result).toBeNull();
  });

  it('a start a watched session reports before it answers is matched', async () => {
    vi.useFakeTimers();
    await attachTab(42);
    let answer = () => {};
    sendCommand.mockImplementation((_t: unknown, method: string) =>
      method === BARRIER ? new Promise((r) => { answer = () => r({}); }) : Promise.resolve({}));
    let result: unknown = 'pending';
    void awaitTabDownloadStart(item).then((s) => { result = s; });
    await vi.advanceTimersByTimeAsync(TAB_DOWNLOAD_START_GRACE_MS * 4);
    expect(result).toBe('pending');
    willBegin(42, 'g-before-answer');
    answer();
    await vi.advanceTimersByTimeAsync(0);
    expect(result).toEqual(expect.objectContaining({ tabId: 42, guid: 'g-before-answer' }));
  });

  it('a start reported inside the grace after the last answer is still matched', async () => {
    vi.useFakeTimers();
    await attachTab(42);
    const pending = awaitTabDownloadStart(item);
    await vi.advanceTimersByTimeAsync(TAB_DOWNLOAD_START_GRACE_MS - 1);
    willBegin(42, 'g-in-grace');
    await expect(pending).resolves.toEqual(expect.objectContaining({ tabId: 42, guid: 'g-in-grace' }));
  });

  it('a session that fails the command, such as one detached meanwhile, counts as answered', async () => {
    vi.useFakeTimers();
    await attachTab(42);
    sendCommand.mockImplementation((_t: unknown, method: string) =>
      method === BARRIER ? Promise.reject(new Error('Detached while handling command.')) : Promise.resolve({}));
    let result: unknown = 'pending';
    void awaitTabDownloadStart(item).then((s) => { result = s; });
    await vi.advanceTimersByTimeAsync(TAB_DOWNLOAD_START_GRACE_MS);
    expect(result).toBeNull();
  });

  it('any error from the command ends the wait on that session, also one from a session that stays attached', async () => {
    vi.useFakeTimers();
    await attachTab(42);
    sendCommand.mockImplementation((_t: unknown, method: string) =>
      method === BARRIER ? Promise.reject(new Error('Not allowed')) : Promise.resolve({}));
    let result: unknown = 'pending';
    void awaitTabDownloadStart(item).then((s) => { result = s; });
    await vi.advanceTimersByTimeAsync(TAB_DOWNLOAD_START_GRACE_MS);
    expect(result).toBeNull();
    expect(isTabDownloadWatched(42)).toBe(true);
  });

  it('a session that never answers holds the item until the end of the window, no longer', async () => {
    vi.useFakeTimers();
    await attachTab(42);
    sendCommand.mockImplementation((_t: unknown, method: string) =>
      method === BARRIER ? new Promise(() => {}) : Promise.resolve({}));
    let result: unknown = 'pending';
    void awaitTabDownloadStart(item).then((s) => { result = s; });
    await vi.advanceTimersByTimeAsync(TAB_DOWNLOAD_START_WINDOW_MS - 1);
    expect(result).toBe('pending');
    await vi.advanceTimersByTimeAsync(1);
    expect(result).toBeNull();
  });

  it('with no watched tab, a download item resolves null at once', async () => {
    await expect(awaitTabDownloadStart(item)).resolves.toBeNull();
  });

  // #94: an item stopped waiting at the end of the grace, and a start for its
  // URL reported later stayed for the next download of that URL.
  it('a start reported after an item stopped waiting at the end of the grace is not handed to the next item of its URL', async () => {
    vi.useFakeTimers();
    await attachTab(42);
    let first: unknown = 'pending';
    void awaitTabDownloadStart(item).then((s) => { first = s; });
    await vi.advanceTimersByTimeAsync(400);
    expect(first).toBeNull();
    willBegin(42, 'g-late');
    let second: unknown = 'pending';
    void awaitTabDownloadStart(item).then((s) => { second = s; });
    await vi.advanceTimersByTimeAsync(TAB_DOWNLOAD_START_GRACE_MS);
    expect(second).toBeNull();
  });

  it('with creation times, a start reported after the grace and at most 1 s after the item was created is dropped', async () => {
    vi.useFakeTimers();
    await attachTab(42);
    const first = awaitTabDownloadStart({ id: 1, ...item, startTime: new Date().toISOString() });
    await vi.advanceTimersByTimeAsync(TAB_DOWNLOAD_START_GRACE_MS);
    await expect(first).resolves.toBeNull();
    // Another download of the URL, created before the report, that it could also be.
    const second = { id: 2, ...item, startTime: new Date().toISOString() };
    await vi.advanceTimersByTimeAsync(150);
    willBegin(42, 'g-late');
    let result: unknown = 'pending';
    void awaitTabDownloadStart(second).then((s) => { result = s; });
    await vi.advanceTimersByTimeAsync(TAB_DOWNLOAD_START_GRACE_MS);
    expect(result).toBeNull();
  });

  it('an item that stopped waiting takes one late start of its URL, and the next start goes to the next item', async () => {
    vi.useFakeTimers();
    await attachTab(42);
    const first = awaitTabDownloadStart(item);
    await vi.advanceTimersByTimeAsync(TAB_DOWNLOAD_START_GRACE_MS);
    await expect(first).resolves.toBeNull();
    willBegin(42, 'g-late');
    willBegin(42, 'g-next');
    await expect(awaitTabDownloadStart(item)).resolves.toEqual(expect.objectContaining({ guid: 'g-next' }));
  });

  it('a start reported after the matching window of the item that stopped waiting is kept for the next item', async () => {
    vi.useFakeTimers();
    await attachTab(42);
    const first = awaitTabDownloadStart(item);
    await vi.advanceTimersByTimeAsync(TAB_DOWNLOAD_START_GRACE_MS);
    await expect(first).resolves.toBeNull();
    await vi.advanceTimersByTimeAsync(TAB_DOWNLOAD_START_WINDOW_MS - TAB_DOWNLOAD_START_GRACE_MS + 1);
    willBegin(42, 'g-after-window');
    await expect(awaitTabDownloadStart(item)).resolves.toEqual(expect.objectContaining({ guid: 'g-after-window' }));
  });

  it('a start reported more than 1 s after the item that stopped waiting was created is not its start, and is kept', async () => {
    vi.useFakeTimers();
    await attachTab(42);
    const first = awaitTabDownloadStart({ id: 1, ...item, startTime: new Date().toISOString() });
    await vi.advanceTimersByTimeAsync(TAB_DOWNLOAD_START_GRACE_MS);
    await expect(first).resolves.toBeNull();
    await vi.advanceTimersByTimeAsync(TAB_DOWNLOAD_START_CANDIDATE_MS);
    const next = { id: 2, ...item, startTime: new Date().toISOString() };
    willBegin(42, 'g-next');
    await expect(awaitTabDownloadStart(next)).resolves.toEqual(expect.objectContaining({ guid: 'g-next' }));
  });

  it('a start on a session the item that stopped waiting did not wait on is kept for the next item', async () => {
    vi.useFakeTimers();
    await attachTab(42);
    const first = awaitTabDownloadStart(item);
    await vi.advanceTimersByTimeAsync(TAB_DOWNLOAD_START_GRACE_MS);
    await expect(first).resolves.toBeNull();
    await attachTab(43);
    willBegin(43, 'g-43');
    await expect(awaitTabDownloadStart(item)).resolves.toEqual(expect.objectContaining({ tabId: 43, guid: 'g-43' }));
  });

  describe('with another download of the same URL', () => {
    const listed = (ids: number[], startTime = new Date().toISOString()) =>
      ids.map((id) => ({ id, url: item.url, startTime }));
    const setSearch = (search: ReturnType<typeof vi.fn>) => {
      (chrome as unknown as Record<string, unknown>).downloads = { search };
    };

    it('waits while one report could be either download, and takes the first start once both are reported', async () => {
      await attachTab(42);
      const both = listed([1, 2]);
      setSearch(vi.fn(() => Promise.resolve(both)));
      willBegin(42, 'g1');
      const first = awaitTabDownloadStart({ id: 1, ...item });
      let settled = false;
      void first.then(() => { settled = true; });
      await new Promise((r) => setTimeout(r, 0));
      expect(settled).toBe(false);
      willBegin(42, 'g2');
      await expect(first).resolves.toEqual(expect.objectContaining({ guid: 'g1' }));
      await expect(awaitTabDownloadStart({ id: 2, ...item })).resolves.toEqual(expect.objectContaining({ guid: 'g2' }));
    });

    it('resolves null once every watched session has answered when no second report comes, long before the window ends', async () => {
      vi.useFakeTimers();
      await attachTab(42);
      const both = listed([1, 2]);
      setSearch(vi.fn(() => Promise.resolve(both)));
      willBegin(42, 'g1');
      let result: unknown = 'pending';
      void awaitTabDownloadStart({ id: 1, ...item }).then((s) => { result = s; });
      await vi.advanceTimersByTimeAsync(TAB_DOWNLOAD_START_GRACE_MS - 1);
      expect(result).toBe('pending');
      await vi.advanceTimersByTimeAsync(1);
      expect(result).toBeNull();
    });

    it('a start reported while an earlier check is still listing downloads at the end of the grace is matched', async () => {
      vi.useFakeTimers();
      await attachTab(42);
      const search = vi.fn(() => Promise.resolve([] as unknown[]));
      setSearch(search);
      let result: unknown = 'pending';
      void awaitTabDownloadStart({ id: 1, ...item }).then((s) => { result = s; });
      await vi.advanceTimersByTimeAsync(TAB_DOWNLOAD_START_GRACE_MS - 1);
      search.mockImplementationOnce(() => new Promise(() => {}));
      willBegin(42, 'g1');
      await vi.advanceTimersByTimeAsync(1);
      expect(result).toEqual(expect.objectContaining({ guid: 'g1' }));
    });

    it('a download that took a start more than two windows ago competes for a start of its URL again', async () => {
      vi.useFakeTimers();
      await attachTab(42);
      // Listed with no creation time, so time alone never rules it out.
      const first = { id: 1, ...item };
      willBegin(42, 'g1');
      expect(takeTabDownloadStart(first)).toEqual(expect.objectContaining({ guid: 'g1' }));
      vi.advanceTimersByTime(2 * TAB_DOWNLOAD_START_WINDOW_MS);
      willBegin(42, 'g2');
      expect(takeTabDownloadStart({ id: 2, ...item }, Date.now(), [first, { id: 2, ...item }]))
        .toEqual(expect.objectContaining({ guid: 'g2' }));
      vi.advanceTimersByTime(1);
      willBegin(42, 'g3');
      expect(takeTabDownloadStart({ id: 3, ...item }, Date.now(), [first, { id: 2, ...item }, { id: 3, ...item }]))
        .toBeNull();
    });

    it('a download whose late start was dropped no longer counts against the next start of its URL', async () => {
      vi.useFakeTimers();
      await attachTab(42);
      const first = { id: 1, ...item, startTime: new Date().toISOString() };
      setSearch(vi.fn(() => Promise.resolve([first])));
      const lapsed = awaitTabDownloadStart(first);
      await vi.advanceTimersByTimeAsync(TAB_DOWNLOAD_START_GRACE_MS);
      await expect(lapsed).resolves.toBeNull();
      willBegin(42, 'g-late');
      const second = { id: 2, ...item, startTime: new Date().toISOString() };
      setSearch(vi.fn(() => Promise.resolve([first, second])));
      willBegin(42, 'g2');
      await expect(awaitTabDownloadStart(second)).resolves.toEqual(expect.objectContaining({ guid: 'g2' }));
    });

    it('a failed search matches nothing', async () => {
      vi.useFakeTimers();
      await attachTab(42);
      setSearch(vi.fn(() => Promise.reject(new Error('unavailable'))));
      willBegin(42, 'g1');
      const pending = awaitTabDownloadStart({ id: 1, ...item });
      await vi.advanceTimersByTimeAsync(TAB_DOWNLOAD_START_WINDOW_MS);
      await expect(pending).resolves.toBeNull();
    });
  });
});
