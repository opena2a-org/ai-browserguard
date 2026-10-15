/**
 * @vitest-environment jsdom
 *
 * Regression (#126): the content script reported the same agent on the same
 * page again every few seconds. Its duplicate check compared each sweep's
 * agent id, which every sweep draws anew, with the one before, so it never
 * matched, and the WebDriver and CDP monitor callbacks had no check at all.
 * An idle page with `<html webdriver>` filled the detection log in Chromium.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import '../__tests__/setup';
import { startDetectionMonitor } from './detector';
import type { DetectionVerdictResult } from './detector';

function reportedPages(reports: DetectionVerdictResult[]): string[] {
  return reports.filter((r) => r.agent).map((r) => new URL(r.event.url).pathname);
}

describe('the detection monitor reports an agent once per page', () => {
  let stop: (() => void) | null = null;

  beforeEach(() => {
    vi.useFakeTimers();
    history.replaceState(null, '', '/cart');
    document.documentElement.setAttribute('webdriver', '');
  });

  afterEach(() => {
    stop?.();
    stop = null;
    document.documentElement.removeAttribute('webdriver');
    vi.useRealTimers();
  });

  it('an idle page whose root element is <html webdriver> is reported once in 70 s', async () => {
    const reports: DetectionVerdictResult[] = [];
    stop = startDetectionMonitor({}, (verdict) => reports.push(verdict));

    await vi.advanceTimersByTimeAsync(70_000);

    expect(reportedPages(reports)).toEqual(['/cart']);
  });

  it('the agent is reported again when the page moves to another address, and once there', async () => {
    const reports: DetectionVerdictResult[] = [];
    stop = startDetectionMonitor({}, (verdict) => reports.push(verdict));

    await vi.advanceTimersByTimeAsync(10_000);
    history.pushState(null, '', '/checkout');
    await vi.advanceTimersByTimeAsync(30_000);

    expect(reportedPages(reports)).toEqual(['/cart', '/checkout']);
  });
});
