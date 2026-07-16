/**
 * The opt-out contract: a failed delete is never reported as a kept promise.
 *
 * The privacy policy states that turning "Read site safety declarations" off
 * deletes every stored declaration. Three things have to hold for that sentence
 * to be true, and each was broken at some point in this feature's history:
 *
 *   1. `clearAiSafetyCache` must REJECT on failure rather than swallow it.
 *      It used to catch internally, so the caller could not tell.
 *   2. The background must report the delete's outcome separately from the
 *      setting's, since the setting saving and the delete failing are different
 *      events and `success:false` would misreport the first.
 *   3. The popup must READ that response. `sendToBackground` RESOLVES with
 *      `{success:false}` rather than rejecting, so a lone `.catch()` sees
 *      nothing — an earlier version "surfaced" the failure into a `.catch()`
 *      that could never fire, which moved the swallow rather than removing it.
 *
 * (1) is pinned here. (2) and (3) live in the service worker and popup, both
 * side-effect modules a test cannot import; they are pinned at source level
 * below, which is the same approach popup.dom.test.ts takes and is what this
 * repo's test env allows.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { clearAiSafetyCache, writeCachedLookup, getAiSafetyCacheSize } from './cache';
import type { AiSafetyLookupResult } from './types';

const OK: AiSafetyLookupResult = { status: 'ok', declaration: { aiSafe: true } };

beforeEach(async () => {
  await clearAiSafetyCache();
});

describe('clearAiSafetyCache is not best-effort', () => {
  it('deletes every stored declaration', async () => {
    await writeCachedLookup('https://a.example', OK, 60_000);
    await writeCachedLookup('https://b.example', OK, 60_000);
    await clearAiSafetyCache();
    expect(await getAiSafetyCacheSize()).toBe(0);
  });

  it('rejects when the delete fails', async () => {
    // A failed WRITE is best-effort: it costs a refetch. A failed CLEAR leaves
    // third-party data on disk after the user revoked consent. The caller must
    // be able to tell the difference.
    const remove = chrome.storage.local.remove as unknown as ReturnType<typeof vi.fn>;
    const original = remove.getMockImplementation();
    remove.mockRejectedValueOnce(new Error('storage unavailable'));
    try {
      await expect(clearAiSafetyCache()).rejects.toThrow('storage unavailable');
    } finally {
      if (original) remove.mockImplementation(original);
    }
  });
});

describe('the background reports the delete outcome (source lock-in)', () => {
  const source = readFileSync(
    resolve(__dirname, '..', 'background', 'index.ts'),
    'utf-8',
  );
  const handler = source.slice(source.indexOf("case 'SETTINGS_UPDATE'"), source.indexOf("case 'SETTINGS_UPDATE'") + 3000);

  it('only clears when the update actually touched the flag', () => {
    // The flag is OFF by default, so gating on its value alone fires a storage
    // delete on every unrelated toggle — and, now that the clear can fail
    // loudly, lets a Notifications toggle report a failure for a settings write
    // that landed.
    expect(handler).toMatch(/hasOwnProperty\.call\(\s*updates,\s*'aiSafetyTxtEnabled'/);
  });

  it('reports declarationsCleared separately from success', () => {
    expect(handler).toMatch(/declarationsCleared:\s*true/);
    expect(handler).toMatch(/declarationsCleared:\s*false/);
  });

  it('does not swallow the clear failure', () => {
    expect(handler).not.toMatch(/clearAiSafetyCache\(\)\.catch\(/);
  });
});

describe('the popup surfaces the delete outcome (source lock-in)', () => {
  const source = readFileSync(resolve(__dirname, '..', 'popup', 'popup.ts'), 'utf-8');

  it('reads the SETTINGS_UPDATE response instead of discarding it', () => {
    // sendToBackground resolves with {success:false}; it does not reject. A
    // `.catch()`-only handler therefore never observes a failure.
    expect(source).toMatch(/declarationsCleared\s*===\s*false/);
  });

  it('tells the user when declarations could not be deleted', () => {
    expect(source).toMatch(/could not be deleted/i);
  });
});
