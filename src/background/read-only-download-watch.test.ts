/**
 * Regression (#100): a delegation the wizard produces cancels a download in
 * the agent's tab without blocking any site.
 *
 * A download is cancelled only when Chrome reports it starting in the agent's
 * tab, on a debugger session Browser-layer blocking holds there. That session
 * used to attach only to a tab whose rule had a site block pattern, and a
 * Read-Only rule never has one (the wizard skips the sites step for it), so
 * under Read-Only the agent's download in its own tab completed and was
 * recorded as a host match. The session now attaches whenever the tab's rule
 * withholds download-file, and pauses no request unless the rule blocks a site.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { chromeMock } from '../__tests__/setup';
import { installDownloadTabWatch } from '../__tests__/download-tab-watch';
import {
  addSitePattern,
  createInitialWizardState,
  finalizeWizard,
  selectPreset,
  setDuration,
} from '../delegation/wizard';
import type { DelegationRule } from '../types/delegation';

const POPUP_SENDER = { id: 'test-id', url: 'chrome-extension://test-id/dist/popup/index.html' };
const CONTENT_SENDER = {
  id: 'test-id',
  tab: { id: 42 },
  frameId: 0,
  url: 'https://example.test/',
  origin: 'https://example.test',
};

type Listener = (msg: unknown, sender: unknown, sendResponse: (r: unknown) => void) => boolean;

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

async function settle(): Promise<void> {
  for (let i = 0; i < 6; i++) await flush();
}

function detectionEvent() {
  return {
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
      originUrl: 'https://example.test/',
      observedCapabilities: [],
      isActive: true,
    },
    url: 'https://example.test/',
    signals: {},
  };
}

/** The rule the wizard creates for `preset` (Limited: one allowed site, 15 minutes). */
function wizardRule(preset: 'readOnly' | 'limited' | 'fullAccess'): DelegationRule {
  let state = selectPreset(createInitialWizardState(), preset);
  if (preset === 'limited') {
    state = setDuration(addSitePattern(state, { pattern: 'example.test', action: 'allow' }), 15);
  }
  const rule = finalizeWizard(state);
  if (!rule) throw new Error(`wizard produced no ${preset} rule`);
  return rule;
}

beforeEach(() => {
  vi.resetModules();
  (chromeMock as unknown as Record<string, unknown>).debugger = undefined;
});

/**
 * Start the worker with Browser-layer blocking on, an agent in tab 42 and
 * `rule` as the session delegation. Returns the download listener, the
 * cancel mock and the debugger mocks.
 */
async function armed(rule: DelegationRule) {
  const downloads = chromeMock.downloads as unknown as Record<string, unknown>;
  downloads.onCreated = { addListener: vi.fn(), removeListener: vi.fn() };
  downloads.cancel = vi.fn((_id: number, cb?: () => void) => { cb?.(); });
  const watch = installDownloadTabWatch();
  const debuggerMock = (chromeMock as unknown as { debugger: { attach: ReturnType<typeof vi.fn> } }).debugger;

  chromeMock.runtime.onMessage.addListener.mockClear();
  await import('./index');
  const calls = chromeMock.runtime.onMessage.addListener.mock.calls;
  const handleMessage = calls[calls.length - 1][0] as Listener;

  handleMessage({ type: 'SETTINGS_UPDATE', data: { cdpEnforcementEnabled: true } }, POPUP_SENDER, vi.fn());
  await settle();
  const detResp = vi.fn();
  handleMessage({ type: 'DETECTION_RESULT', data: detectionEvent() }, CONTENT_SENDER, detResp);
  await settle();
  expect(detResp).toHaveBeenCalledWith(expect.objectContaining({ success: true }));
  const delResp = vi.fn();
  handleMessage({ type: 'DELEGATION_UPDATE', data: rule }, POPUP_SENDER, delResp);
  await settle();
  expect(delResp).toHaveBeenCalledWith(expect.objectContaining({ success: true }));

  const onCreated = (downloads.onCreated as { addListener: { mock: { calls: unknown[][] } } })
    .addListener.mock.calls[0][0] as (item: unknown) => Promise<void>;
  return { onCreated, cancel: downloads.cancel as ReturnType<typeof vi.fn>, watch, attach: debuggerMock.attach };
}

/** The CDP methods sent on tab `tabId`'s session, in order. */
function methodsOn(sendCommand: ReturnType<typeof vi.fn>, tabId: number): string[] {
  return sendCommand.mock.calls
    .filter((c: unknown[]) => (c[0] as { tabId?: number }).tabId === tabId)
    .map((c: unknown[]) => c[1] as string);
}

describe('#100: a wizard-made delegation cancels a download in the agent tab', () => {
  it('Read-Only, which blocks no site, cancels the download Chrome reports starting in the agent tab', async () => {
    const rule = wizardRule('readOnly');
    expect(rule.scope.sitePatterns).toEqual([]);
    const { onCreated, cancel, watch, attach } = await armed(rule);

    // The session attached to watch downloads, and pauses none of the tab's requests.
    expect(attach).toHaveBeenCalledWith({ tabId: 42 }, expect.any(String));
    expect(methodsOn(watch.sendCommand, 42)).toContain('Page.enable');
    expect(methodsOn(watch.sendCommand, 42)).not.toContain('Fetch.enable');

    watch.reportDownloadStart(42, 'https://example.test/exfil.zip');
    await onCreated({ id: 7, url: 'https://example.test/exfil.zip', referrer: 'https://example.test/', filename: '/tmp/exfil.zip' });
    await settle();

    expect(cancel).toHaveBeenCalledWith(7, expect.any(Function));
  });

  it('Limited with only an allowed site cancels the download Chrome reports starting in the agent tab', async () => {
    const rule = wizardRule('limited');
    expect(rule.scope.sitePatterns.every((p) => p.action === 'allow')).toBe(true);
    const { onCreated, cancel, watch } = await armed(rule);

    watch.reportDownloadStart(42, 'https://example.test/exfil.zip');
    await onCreated({ id: 8, url: 'https://example.test/exfil.zip', referrer: 'https://example.test/', filename: '/tmp/exfil.zip' });
    await settle();

    expect(cancel).toHaveBeenCalledWith(8, expect.any(Function));
    expect(methodsOn(watch.sendCommand, 42)).not.toContain('Fetch.enable');
  });

  it('Full Access, which permits downloads and blocks no site, attaches no session', async () => {
    const { onCreated, cancel, attach } = await armed(wizardRule('fullAccess'));

    expect(attach).not.toHaveBeenCalled();
    await onCreated({ id: 9, url: 'https://example.test/ok.pdf', referrer: 'https://example.test/', filename: '/tmp/ok.pdf' });
    await settle();
    expect(cancel).not.toHaveBeenCalled();
  });
});
