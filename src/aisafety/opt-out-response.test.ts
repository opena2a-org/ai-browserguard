/**
 * The opt-out/retry wire shape, tested by OUTCOME.
 *
 * These readers replaced inline casts in the popup that no rename could break.
 * Each branch is asserted here so a wrong mapping (`declarationsCleared:
 * !settled`, or a `=== true` slipping to `=== false`) fails a test rather than
 * silently telling the user their data was or was not deleted.
 */
import { describe, it, expect } from 'vitest';
import {
  optOutRetryResponse,
  settingsWriteFailed,
  declarationDeleteFailed,
  declarationsWereCleared,
} from './opt-out-response';

describe('optOutRetryResponse', () => {
  it('reports declarationsCleared TRUE when nothing is outstanding (settled)', () => {
    expect(optOutRetryResponse(true)).toEqual({ success: true, declarationsCleared: true });
  });

  it('reports declarationsCleared FALSE when the delete is still outstanding', () => {
    // Kills the `!settled` mutation: reporting cleared=true here would tell the
    // user their declarations were deleted while they are still on disk.
    expect(optOutRetryResponse(false)).toEqual({ success: true, declarationsCleared: false });
  });
});

describe('settingsWriteFailed', () => {
  it('is true only for an explicit { success: false }', () => {
    expect(settingsWriteFailed({ success: false })).toBe(true);
  });

  it('is false for a successful save', () => {
    expect(settingsWriteFailed({ success: true, declarationsCleared: true })).toBe(false);
  });

  it.each([
    ['undefined', undefined],
    ['null', null],
    ['an empty object', {}],
    ['a non-object', 'nope'],
  ])('is false for %s', (_label, value) => {
    expect(settingsWriteFailed(value)).toBe(false);
  });
});

describe('declarationDeleteFailed', () => {
  it('is true when the delete explicitly failed', () => {
    expect(declarationDeleteFailed({ success: true, declarationsCleared: false })).toBe(true);
  });

  it('is false when the delete succeeded', () => {
    expect(declarationDeleteFailed({ success: true, declarationsCleared: true })).toBe(false);
  });

  it.each([
    ['a missing flag', { success: true }],
    ['undefined', undefined],
    ['a non-boolean flag', { declarationsCleared: 'no' }],
  ])('is false for %s (absence is not a failure claim)', (_label, value) => {
    expect(declarationDeleteFailed(value)).toBe(false);
  });
});

describe('declarationsWereCleared', () => {
  it('is true only when the flag says so', () => {
    expect(declarationsWereCleared({ success: true, declarationsCleared: true })).toBe(true);
  });

  it('is false when the delete failed', () => {
    expect(declarationsWereCleared({ success: true, declarationsCleared: false })).toBe(false);
  });

  it.each([
    ['a missing flag', { success: true }],
    ['undefined', undefined],
    ['a non-boolean flag', { declarationsCleared: 1 }],
  ])('is false for %s', (_label, value) => {
    expect(declarationsWereCleared(value)).toBe(false);
  });
});
