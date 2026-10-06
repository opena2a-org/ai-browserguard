/**
 * Test helper: a chrome.debugger mock whose sessions report download starts,
 * for tests that need a download cancelled.
 *
 * A download is cancelled only when Chrome reports it starting in an agent's
 * tab on a debugger session the extension holds there. That session exists
 * when Browser-layer blocking is on and the tab's delegation blocks a site, so
 * a test arms both, then reports the start before creating the download item.
 * Install the mock BEFORE importing the worker: it registers its debugger
 * listeners at start-up.
 */
import { vi } from 'vitest';
import { chromeMock } from './setup';
import type { DelegationRule } from '../types/delegation';

type Listener = (...args: unknown[]) => void;

export interface DownloadTabWatch {
  /** Every command sent on a debugger session, in order. */
  sendCommand: ReturnType<typeof vi.fn>;
  /** Fire Chrome's report of a download starting in `tabId`. */
  reportDownloadStart(tabId: number, url: string): void;
}

export function installDownloadTabWatch(targets: unknown[] = []): DownloadTabWatch {
  const listeners: Listener[] = [];
  const sendCommand = vi.fn(() => Promise.resolve({}));
  let guid = 0;
  (chromeMock as unknown as Record<string, unknown>).debugger = {
    attach: vi.fn(() => Promise.resolve()),
    detach: vi.fn(() => Promise.resolve()),
    sendCommand,
    onEvent: { addListener: vi.fn((fn: Listener) => { listeners.push(fn); }) },
    onDetach: { addListener: vi.fn() },
    getTargets: (cb: (t: unknown[]) => void) => cb(targets),
  };
  return {
    sendCommand,
    reportDownloadStart(tabId, url) {
      guid += 1;
      const params = { frameId: `frame-${tabId}`, guid: `guid-${guid}`, url, suggestedFilename: 'file' };
      for (const fn of listeners) fn({ tabId }, 'Page.downloadWillBegin', params);
    },
  };
}

/** `rule` with one blocked site, so Browser-layer blocking attaches to its tabs. */
export function withBlockedSite(rule: DelegationRule): DelegationRule {
  return { ...rule, scope: { ...rule.scope, sitePatterns: [{ pattern: 'blocked.example', action: 'block' }] } };
}
