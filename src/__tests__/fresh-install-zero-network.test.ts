/**
 * Fresh-install zero-network assertion.
 *
 * The Chrome Web Store listing and privacy policy claim the extension makes
 * zero network requests *by default*. This test locks that claim in: with the
 * shipped default settings and default contribution consent, none of the three
 * opt-in network paths (AIM lookup, registry lookup, anonymized contribution)
 * may fire. The gating is what makes the "off by default, optional opt-in"
 * disclosure (ADR-006) true, so a regression here is a disclosure bug.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DEFAULT_SETTINGS } from '../session/types';
import { DEFAULT_CONSENT } from '../contribute/types';
import { getConsent, recordDetection, queueEvent, flushQueue } from '../contribute/client';
import type { ContributeEvent } from '../contribute/types';

// Spy on global fetch. Any call to it during a fresh-install flow fails the test.
const mockFetch = vi.fn(() => {
  throw new Error('fetch must not be called on a fresh install before opt-in');
});
(globalThis as Record<string, unknown>).fetch = mockFetch;
(chrome.runtime as Record<string, unknown>).getManifest = vi.fn(() => ({ version: '0.4.2' }));

beforeEach(() => {
  mockFetch.mockClear();
});

describe('fresh install makes zero network requests', () => {
  it('ships the trust-lookup gates default OFF', () => {
    expect(DEFAULT_SETTINGS.aimLookupEnabled).toBe(false);
    expect(DEFAULT_SETTINGS.registryLookupEnabled).toBe(false);
  });

  it('ships contribution consent default OFF', () => {
    expect(DEFAULT_CONSENT.enabled).toBe(false);
  });

  it('does not fetch when consent defaults to off', async () => {
    const consent = await getConsent();
    expect(consent.enabled).toBe(false);

    // Recording detections (the local tip counter) must never trigger a request.
    await recordDetection();
    await recordDetection();

    // Attempting to queue a contribution event with default (off) consent must
    // be a no-op that never queues and never flushes to the network.
    const event: ContributeEvent = {
      type: 'detection_summary',
      timestamp: new Date(0).toISOString(),
      data: { framework: 'playwright', detectionMethods: [], confidence: 1 } as never,
    };
    await queueEvent(event);

    // An explicit flush on the (empty) queue must also make no request.
    const result = await flushQueue();
    expect(result.sent).toBe(0);

    expect(mockFetch).not.toHaveBeenCalled();
  });
});
