/**
 * Owner pause of the guard (#71).
 *
 * The only way to let an agent work on one site without guard denials was to
 * disable the extension, which dropped protection on every other tab too. A
 * pause stands enforcement down on exactly one site (or everywhere, time-boxed)
 * by resolving the covered tabs' rule to none, the pass-through every
 * enforcement layer already honours. These tests drive the real service worker:
 * on the pre-fix code GUARD_PAUSE does not exist, so every pause is rejected and
 * the paused site keeps its rule.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { chromeMock } from '../__tests__/setup';
import { createRuleFromPreset } from '../delegation/rules';
import type { DelegationRule } from '../types/delegation';

const POPUP_SENDER = { id: 'test-id', url: 'chrome-extension://test-id/dist/popup/index.html' };
const PAUSED_URL = 'https://dashboard.example.test/reports';
const OTHER_URL = 'https://mail.example.test/';

function contentSender(tabId: number, url: string) {
  return { id: 'test-id', tab: { id: tabId, url }, frameId: 0, url, origin: new URL(url).origin };
}

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

type Listener = (msg: unknown, sender: unknown, sendResponse: (r: unknown) => void) => boolean;

async function importWorker(): Promise<Listener> {
  chromeMock.runtime.onMessage.addListener.mockClear();
  await import('./index');
  for (let i = 0; i < 4; i++) await flush();
  const calls = chromeMock.runtime.onMessage.addListener.mock.calls;
  return calls[calls.length - 1][0] as Listener;
}

async function send(handle: Listener, type: string, data: unknown, sender: unknown): Promise<unknown> {
  const resp = vi.fn();
  handle({ type, data }, sender, resp);
  for (let i = 0; i < 8; i++) await flush();
  return resp.mock.calls[0]?.[0];
}

async function ruleFor(handle: Listener, tabId: number, url: string): Promise<DelegationRule | null> {
  const resp = await send(handle, 'TAB_STATE_QUERY', {}, contentSender(tabId, url)) as { effectiveRule: DelegationRule | null };
  return resp.effectiveRule;
}

async function delegateReadOnly(handle: Listener): Promise<DelegationRule> {
  const rule = createRuleFromPreset('readOnly');
  expect(await send(handle, 'DELEGATION_UPDATE', rule, POPUP_SENDER)).toEqual({ success: true });
  return rule;
}

/** The DELEGATION_UPDATE payloads the worker pushed to one tab, in order. */
function pushedTo(tabId: number): unknown[] {
  return chromeMock.tabs.sendMessage.mock.calls
    .filter((c: unknown[]) => c[0] === tabId && (c[1] as { type?: string })?.type === 'DELEGATION_UPDATE')
    .map((c: unknown[]) => (c[1] as { data: unknown }).data);
}

beforeEach(() => {
  vi.resetModules();
  chromeMock.tabs.query.mockImplementation(() => Promise.resolve([
    { id: 42, url: PAUSED_URL },
    { id: 43, url: OTHER_URL },
  ]) as never);
});

afterEach(() => {
  vi.restoreAllMocks();
  chromeMock.tabs.query.mockImplementation(() => Promise.resolve([]) as never);
});

describe('pause on this site (#71)', () => {
  it('lifts enforcement on the paused site and nowhere else', async () => {
    const handle = await importWorker();
    await delegateReadOnly(handle);
    expect(await ruleFor(handle, 42, PAUSED_URL)).toEqual(expect.objectContaining({ preset: 'readOnly' }));

    const resp = await send(handle, 'GUARD_PAUSE', { scope: 'site', host: 'dashboard.example.test', minutes: 60 }, POPUP_SENDER);
    expect(resp).toEqual(expect.objectContaining({ success: true }));

    // The paused site resolves to no rule: no guard denials there.
    expect(await ruleFor(handle, 42, PAUSED_URL)).toBeNull();
    // Every other site, a subdomain of the paused one included, stays guarded.
    expect(await ruleFor(handle, 43, OTHER_URL)).toEqual(expect.objectContaining({ preset: 'readOnly' }));
    expect(await ruleFor(handle, 44, 'https://api.dashboard.example.test/')).toEqual(expect.objectContaining({ preset: 'readOnly' }));
  });

  it('tells the open tab to stand down at once, and hands its rule back on resume', async () => {
    const handle = await importWorker();
    await delegateReadOnly(handle);
    chromeMock.tabs.sendMessage.mockClear();

    const resp = await send(handle, 'GUARD_PAUSE', { scope: 'site', host: 'dashboard.example.test', minutes: null }, POPUP_SENDER) as { pause: { id: string } };
    expect(pushedTo(42)).toEqual([null]);
    expect(pushedTo(43)).toEqual([expect.objectContaining({ preset: 'readOnly' })]);

    chromeMock.tabs.sendMessage.mockClear();
    expect(await send(handle, 'GUARD_RESUME', { id: resp.pause.id }, POPUP_SENDER)).toEqual({ success: true });
    expect(pushedTo(42)).toEqual([expect.objectContaining({ preset: 'readOnly' })]);
    expect(await ruleFor(handle, 42, PAUSED_URL)).toEqual(expect.objectContaining({ preset: 'readOnly' }));

    const status = await send(handle, 'STATUS_QUERY', {}, POPUP_SENDER) as { guardPauses: unknown[]; guardPauseLog: { endReason: string | null }[] };
    expect(status.guardPauses).toEqual([]);
    expect(status.guardPauseLog[0]).toEqual(expect.objectContaining({ host: 'dashboard.example.test', endReason: 'resumed' }));
  });

  it('a page cannot pause the guard on itself', async () => {
    const handle = await importWorker();
    await delegateReadOnly(handle);

    const resp = vi.fn();
    const handled = handle(
      { type: 'GUARD_PAUSE', data: { scope: 'site', host: 'dashboard.example.test', minutes: 60 } },
      contentSender(42, PAUSED_URL),
      resp,
    );
    for (let i = 0; i < 8; i++) await flush();
    expect(handled).toBe(false);
    expect(resp).not.toHaveBeenCalled();
    expect(await ruleFor(handle, 42, PAUSED_URL)).toEqual(expect.objectContaining({ preset: 'readOnly' }));
  });

  it('a tab that navigates off the paused site is guarded again', async () => {
    const handle = await importWorker();
    await delegateReadOnly(handle);
    await send(handle, 'GUARD_PAUSE', { scope: 'site', host: 'dashboard.example.test', minutes: 60 }, POPUP_SENDER);

    expect(await ruleFor(handle, 42, PAUSED_URL)).toBeNull();
    expect(await ruleFor(handle, 42, OTHER_URL)).toEqual(expect.objectContaining({ preset: 'readOnly' }));
  });

  it('does not cancel the agent download on a paused site, and says why on the timeline', async () => {
    const downloads = chromeMock.downloads as unknown as Record<string, unknown>;
    downloads.onCreated = { addListener: vi.fn(), removeListener: vi.fn() };
    downloads.cancel = vi.fn((_id: number, cb?: () => void) => { cb?.(); });
    const handle = await importWorker();

    const detection = {
      id: 'det-1',
      timestamp: new Date().toISOString(),
      methods: ['cdp-connection'],
      confidence: 'high',
      agent: {
        id: 'agent-1',
        type: 'playwright',
        detectionMethods: ['cdp-connection'],
        confidence: 'high',
        detectedAt: new Date().toISOString(),
        originUrl: PAUSED_URL,
        observedCapabilities: [],
        isActive: true,
      },
      url: PAUSED_URL,
      signals: {},
    };
    expect(await send(handle, 'DETECTION_RESULT', detection, contentSender(42, PAUSED_URL))).toEqual({ success: true });
    await delegateReadOnly(handle);
    await send(handle, 'GUARD_PAUSE', { scope: 'site', host: 'dashboard.example.test', minutes: 15 }, POPUP_SENDER);

    const onCreated = (downloads.onCreated as { addListener: { mock: { calls: unknown[][] } } })
      .addListener.mock.calls[0][0] as (item: unknown) => Promise<void>;
    await onCreated({ id: 7, url: 'https://dashboard.example.test/export.csv', referrer: PAUSED_URL, filename: '/tmp/export.csv' });
    for (let i = 0; i < 8; i++) await flush();
    expect(downloads.cancel).not.toHaveBeenCalled();

    const sessions = (await send(handle, 'SESSION_QUERY', {}, POPUP_SENDER) as { sessions: { events: { type: string; description: string }[] }[] }).sessions;
    const descriptions = sessions[0].events.map((e) => e.description);
    expect(descriptions).toContain('You paused the guard on dashboard.example.test for 15 minutes');
    expect(descriptions).toContain("Download from the agent's host: export.csv (guard paused)");
  });
});

describe('pause everywhere (#71)', () => {
  it('is always time-boxed and covers every site', async () => {
    const handle = await importWorker();
    await delegateReadOnly(handle);

    expect(await send(handle, 'GUARD_PAUSE', { scope: 'all', host: null, minutes: null }, POPUP_SENDER))
      .toEqual(expect.objectContaining({ success: false }));
    expect(await ruleFor(handle, 43, OTHER_URL)).toEqual(expect.objectContaining({ preset: 'readOnly' }));

    expect(await send(handle, 'GUARD_PAUSE', { scope: 'all', host: null, minutes: 15 }, POPUP_SENDER))
      .toEqual(expect.objectContaining({ success: true }));
    expect(await ruleFor(handle, 42, PAUSED_URL)).toBeNull();
    expect(await ruleFor(handle, 43, OTHER_URL)).toBeNull();
  });

  it('ends on time: enforcement returns and the history records the window', async () => {
    const start = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(start);
    const handle = await importWorker();
    await delegateReadOnly(handle);
    const resp = await send(handle, 'GUARD_PAUSE', { scope: 'all', host: null, minutes: 15 }, POPUP_SENDER) as { pause: { expiresAt: string } };
    expect(chromeMock.alarms.create).toHaveBeenCalledWith('guard-pause-expiry', { when: start + 15 * 60_000 });
    expect(await ruleFor(handle, 43, OTHER_URL)).toBeNull();

    clock.mockReturnValue(start + 15 * 60_000 + 1);
    // The worker's own checks are against the clock, before the alarm fires...
    expect(await ruleFor(handle, 43, OTHER_URL)).toEqual(expect.objectContaining({ preset: 'readOnly' }));

    // ...and the alarm re-arms the open tabs and closes the history entry.
    chromeMock.tabs.sendMessage.mockClear();
    // Fire this worker's listener only: earlier tests' workers stay registered
    // on the shared mock.
    const alarmListeners = chromeMock.alarms.onAlarm._listeners;
    alarmListeners[alarmListeners.length - 1]({ name: 'guard-pause-expiry' });
    for (let i = 0; i < 8; i++) await flush();
    expect(pushedTo(42)).toEqual([expect.objectContaining({ preset: 'readOnly' })]);
    const status = await send(handle, 'STATUS_QUERY', {}, POPUP_SENDER) as { guardPauses: unknown[]; guardPauseLog: { endReason: string; endedAt: string }[] };
    expect(status.guardPauses).toEqual([]);
    expect(status.guardPauseLog[0]).toEqual(expect.objectContaining({
      scope: 'all',
      endReason: 'expired',
      endedAt: resp.pause.expiresAt,
    }));
  });
});

describe('pause and the kill switch (#71)', () => {
  it('the kill switch ends every pause, and no pause starts while it is on', async () => {
    const handle = await importWorker();
    await delegateReadOnly(handle);
    await send(handle, 'GUARD_PAUSE', { scope: 'site', host: 'dashboard.example.test', minutes: null }, POPUP_SENDER);

    expect(await send(handle, 'KILL_SWITCH_ACTIVATE', { trigger: 'button' }, POPUP_SENDER))
      .toEqual(expect.objectContaining({ success: true }));
    const status = await send(handle, 'STATUS_QUERY', {}, POPUP_SENDER) as { guardPauses: unknown[]; guardPauseLog: { endReason: string }[] };
    expect(status.guardPauses).toEqual([]);
    expect(status.guardPauseLog[0]).toEqual(expect.objectContaining({ endReason: 'kill-switch' }));

    const refused = await send(handle, 'GUARD_PAUSE', { scope: 'all', host: null, minutes: 15 }, POPUP_SENDER) as { success: boolean; reason: string };
    expect(refused.success).toBe(false);
    expect(refused.reason).toContain('kill switch');
  });
});

describe('pause across a worker restart (#71)', () => {
  it('a live pause is restored from storage', async () => {
    let handle = await importWorker();
    await delegateReadOnly(handle);
    await send(handle, 'GUARD_PAUSE', { scope: 'site', host: 'dashboard.example.test', minutes: 60 }, POPUP_SENDER);

    vi.resetModules();
    handle = await importWorker();
    expect(await ruleFor(handle, 42, PAUSED_URL)).toBeNull();
    expect(await ruleFor(handle, 43, OTHER_URL)).toEqual(expect.objectContaining({ preset: 'readOnly' }));
  });
});
