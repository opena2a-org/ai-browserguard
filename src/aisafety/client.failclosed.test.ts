/**
 * The opt-in gate fails CLOSED.
 *
 * Separate file because it must mock `session/storage` wholesale, while
 * `client.test.ts` needs the real one.
 *
 * Why this exists at all: the obvious version of this test — reject
 * `chrome.storage.local.get` and assert no request — proves nothing.
 * `getStorageState()` (`session/storage.ts:298`) catches every error and returns
 * `{...DEFAULT_STORAGE}`, so `getSettings()` is total and never rejects. That
 * test passes against a client with NO gate at all, purely because
 * `DEFAULT_SETTINGS.aiSafetyTxtEnabled` is false. It asserts the default value
 * while appearing to assert the behaviour — the exact substitution the comment
 * in `client.ts` was written to warn about, reintroduced by the test meant to
 * prevent it.
 *
 * Mocking the storage module instead makes `getSettings` genuinely reject, so
 * the catch in `isEnabled` is reachable and the guarantee is actually exercised.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../session/storage', () => ({
  getSettings: vi.fn(),
}));

import { lookupAiSafetyDeclaration } from './client';
import { clearAiSafetyCache } from './cache';
import { getSettings } from '../session/storage';

const mockFetch = vi.fn();
(globalThis as Record<string, unknown>).fetch = mockFetch;

beforeEach(async () => {
  await clearAiSafetyCache();
  mockFetch.mockReset();
  vi.mocked(getSettings).mockReset();
});

describe('the gate fails closed', () => {
  it('makes no request when the settings read rejects', async () => {
    vi.mocked(getSettings).mockRejectedValueOnce(new Error('storage exploded'));

    const result = await lookupAiSafetyDeclaration('https://example.com/page');

    // An unreadable setting is not consent.
    expect(mockFetch).not.toHaveBeenCalled();
    expect(result).toEqual({ status: 'unreachable' });
  });

  it('makes no request when settings come back without the flag', async () => {
    // A partial/migrated settings object must not read as opted in.
    vi.mocked(getSettings).mockResolvedValueOnce({} as never);

    const result = await lookupAiSafetyDeclaration('https://example.com/page');
    expect(mockFetch).not.toHaveBeenCalled();
    expect(result).toEqual({ status: 'unreachable' });
  });

  it.each([
    ['a truthy non-boolean', 'yes'],
    ['the number 1', 1],
    ['a truthy object', {}],
  ])('makes no request when the flag is %s rather than true', async (_label, value) => {
    // The check is `=== true`, so nothing merely truthy opts the user in.
    vi.mocked(getSettings).mockResolvedValueOnce({ aiSafetyTxtEnabled: value } as never);

    const result = await lookupAiSafetyDeclaration('https://example.com/page');
    expect(mockFetch).not.toHaveBeenCalled();
    expect(result).toEqual({ status: 'unreachable' });
  });

  it('DOES request when the flag is exactly true (proves the mock is not the reason)', async () => {
    // Without this, every assertion above would also pass against a client that
    // never fetches at all.
    //
    // mockResolvedValue, not ...Once: the gate is read TWICE per lookup — once
    // before the fetch, and again before the cache write, so that consent
    // revoked mid-flight cannot land a straggler on disk. A one-shot mock would
    // leave the second read undefined and fail this for the wrong reason.
    vi.mocked(getSettings).mockResolvedValue({ aiSafetyTxtEnabled: true } as never);
    mockFetch.mockResolvedValueOnce({
      type: 'basic',
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'text/plain' }),
      body: null,
      text: () => Promise.resolve('AI-Safe: true\n'),
    });

    const result = await lookupAiSafetyDeclaration('https://example.com/page');
    expect(mockFetch).toHaveBeenCalledOnce();
    expect(result).toEqual({ status: 'ok', declaration: { aiSafe: true } });
  });
});
