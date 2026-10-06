/**
 * Owner pause rules (#71): bounds, matching, replacement, expiry and history.
 */
import { describe, it, expect } from 'vitest';
import {
  createPause,
  isPauseLive,
  pauseCovering,
  applyPause,
  splitExpiredPauses,
  nextPauseExpiry,
  logPauseStarted,
  logPauseEnded,
  isGuardPause,
  isPauseLogEntry,
  pausableHostOf,
  describePauseDuration,
  MAX_PAUSE_LOG_ENTRIES,
  PAUSE_END_REASON_LABELS,
  pauseEndReasonLabel,
} from './pause';
import type { GuardPause } from './pause';

const NOW = Date.parse('2026-10-05T12:00:00.000Z');
const MIN = 60_000;

function sitePause(host: string, minutes: number | null, id = `site-${host}`): GuardPause {
  const r = createPause({ scope: 'site', host, minutes }, NOW, id);
  if (!r.ok) throw new Error(r.reason);
  return r.pause;
}

function allPause(minutes: number, id = 'all'): GuardPause {
  const r = createPause({ scope: 'all', host: null, minutes }, NOW, id);
  if (!r.ok) throw new Error(r.reason);
  return r.pause;
}

describe('createPause', () => {
  it('accepts a site pause of 15 or 60 minutes, or until resumed', () => {
    expect(sitePause('Dashboard.Example.com', 60)).toEqual({
      id: 'site-Dashboard.Example.com',
      scope: 'site',
      host: 'dashboard.example.com',
      startedAt: '2026-10-05T12:00:00.000Z',
      expiresAt: '2026-10-05T13:00:00.000Z',
    });
    expect(sitePause('example.com', 15).expiresAt).toBe('2026-10-05T12:15:00.000Z');
    expect(sitePause('example.com', null).expiresAt).toBeNull();
  });

  it('rejects a site pause without a usable host or with another duration', () => {
    for (const host of [undefined, '', '*.example.com', 'https://example.com', 'example.com/path', 'a b']) {
      expect(createPause({ scope: 'site', host, minutes: 60 }, NOW, 'x').ok).toBe(false);
    }
    for (const minutes of [0, 5, 240, -15, '60', undefined]) {
      expect(createPause({ scope: 'site', host: 'example.com', minutes }, NOW, 'x').ok).toBe(false);
    }
  });

  it('a pause everywhere is always time-boxed', () => {
    expect(allPause(15).expiresAt).toBe('2026-10-05T12:15:00.000Z');
    expect(allPause(60).expiresAt).toBe('2026-10-05T13:00:00.000Z');
    expect(createPause({ scope: 'all', host: null, minutes: null }, NOW, 'x').ok).toBe(false);
    expect(createPause({ scope: 'all', host: null, minutes: 240 }, NOW, 'x').ok).toBe(false);
  });

  it('rejects an unknown scope', () => {
    expect(createPause({ scope: 'tab', host: 'example.com', minutes: 15 }, NOW, 'x').ok).toBe(false);
  });
});

describe('isPauseLive / pauseCovering', () => {
  it('a timed pause is live until its expiry, an open-ended site pause until resumed', () => {
    const p = sitePause('example.com', 15);
    expect(isPauseLive(p, NOW + 15 * MIN - 1)).toBe(true);
    expect(isPauseLive(p, NOW + 15 * MIN)).toBe(false);
    expect(isPauseLive(sitePause('example.com', null), NOW + 10_000 * MIN)).toBe(true);
  });

  it('an unreadable expiry counts as ended (fails back to enforcement)', () => {
    expect(isPauseLive({ ...sitePause('example.com', 15), expiresAt: 'not a date' }, NOW)).toBe(false);
    expect(isPauseLive({ ...allPause(15), expiresAt: null }, NOW)).toBe(false);
  });

  it('a site pause covers exactly its host', () => {
    const pauses = [sitePause('example.com', 60)];
    expect(pauseCovering(pauses, 'example.com', NOW)?.id).toBe('site-example.com');
    expect(pauseCovering(pauses, 'EXAMPLE.com', NOW)?.id).toBe('site-example.com');
    expect(pauseCovering(pauses, 'www.example.com', NOW)).toBeNull();
    expect(pauseCovering(pauses, 'example.com.evil.test', NOW)).toBeNull();
    expect(pauseCovering(pauses, null, NOW)).toBeNull();
  });

  it('a pause everywhere covers every page, an unknown one included; the site pause is preferred', () => {
    const pauses = [allPause(15), sitePause('example.com', 60)];
    expect(pauseCovering(pauses, 'other.test', NOW)?.id).toBe('all');
    expect(pauseCovering(pauses, null, NOW)?.id).toBe('all');
    expect(pauseCovering(pauses, 'example.com', NOW)?.id).toBe('site-example.com');
  });

  it('an expired pause covers nothing', () => {
    expect(pauseCovering([allPause(15)], 'other.test', NOW + 16 * MIN)).toBeNull();
  });
});

describe('applyPause', () => {
  it('replaces an earlier pause with the same reach, keeps the rest', () => {
    const first = sitePause('example.com', 15, 'first');
    const other = sitePause('other.test', 60, 'other');
    const everywhere = allPause(15, 'everywhere');
    const second = sitePause('example.com', null, 'second');
    const { pauses, replaced } = applyPause([first, other, everywhere], second);
    expect(pauses.map((p) => p.id)).toEqual(['other', 'everywhere', 'second']);
    expect(replaced.map((p) => p.id)).toEqual(['first']);
  });
});

describe('expiry helpers', () => {
  it('splits live from expired and finds the next end', () => {
    const short = sitePause('a.test', 15, 'short');
    const long = sitePause('b.test', 60, 'long');
    const open = sitePause('c.test', null, 'open');
    expect(nextPauseExpiry([long, open, short], NOW)).toBe(NOW + 15 * MIN);
    const { live, expired } = splitExpiredPauses([short, long, open], NOW + 20 * MIN);
    expect(live.map((p) => p.id)).toEqual(['long', 'open']);
    expect(expired.map((p) => p.id)).toEqual(['short']);
    expect(nextPauseExpiry(live, NOW + 20 * MIN)).toBe(NOW + 60 * MIN);
    expect(nextPauseExpiry([open], NOW)).toBeNull();
  });
});

describe('pause history', () => {
  it('records the start, then the end with the window that was actually unguarded', () => {
    const p = sitePause('example.com', 15);
    let log = logPauseStarted([], p);
    expect(log[0]).toEqual(expect.objectContaining({ id: p.id, endedAt: null, endReason: null }));
    // Noticed by a tick 40 s late: the history still says it ended at its expiry.
    log = logPauseEnded(log, p, 'expired', NOW + 15 * MIN + 40_000);
    expect(log[0]).toEqual(expect.objectContaining({ endedAt: p.expiresAt, endReason: 'expired' }));
  });

  it('a resume is stamped with the time it happened, and a closed entry is not reopened', () => {
    const p = sitePause('example.com', null);
    let log = logPauseEnded(logPauseStarted([], p), p, 'resumed', NOW + 5 * MIN);
    expect(log[0].endedAt).toBe(new Date(NOW + 5 * MIN).toISOString());
    log = logPauseEnded(log, p, 'kill-switch', NOW + 9 * MIN);
    expect(log[0].endReason).toBe('resumed');
  });

  it('is bounded, newest first', () => {
    let log = logPauseStarted([], sitePause('first.test', 15, 'first'));
    for (let i = 0; i < MAX_PAUSE_LOG_ENTRIES + 5; i++) {
      log = logPauseStarted(log, sitePause('x.test', 15, `p${i}`));
    }
    expect(log).toHaveLength(MAX_PAUSE_LOG_ENTRIES);
    expect(log[0].id).toBe(`p${MAX_PAUSE_LOG_ENTRIES + 4}`);
    expect(log.some((e) => e.id === 'first')).toBe(false);
  });
});

describe('isGuardPause (stored shape)', () => {
  it('accepts what createPause builds and rejects damaged records', () => {
    expect(isGuardPause(sitePause('example.com', null))).toBe(true);
    expect(isGuardPause(allPause(15))).toBe(true);
    expect(isGuardPause(null)).toBe(false);
    expect(isGuardPause({ ...sitePause('example.com', 15), host: '*.example.com' })).toBe(false);
    expect(isGuardPause({ ...allPause(15), expiresAt: null })).toBe(false);
    expect(isGuardPause({ ...allPause(15), host: 'example.com' })).toBe(false);
    expect(isGuardPause({ ...allPause(15), scope: 'tab' })).toBe(false);
  });
});

describe('isPauseLogEntry (stored shape)', () => {
  const ended = { ...allPause(15), endedAt: new Date(NOW + 15 * MIN).toISOString() };

  it('accepts a live entry and every end reason the history has a label for', () => {
    expect(isPauseLogEntry(logPauseStarted([], allPause(15))[0])).toBe(true);
    for (const endReason of Object.keys(PAUSE_END_REASON_LABELS)) {
      expect(isPauseLogEntry({ ...ended, endReason })).toBe(true);
    }
  });

  it('keeps an end reason the history has no label for, which a later version may have written', () => {
    expect(isPauseLogEntry({ ...ended, endReason: 'x' })).toBe(true);
    expect(isPauseLogEntry({ ...ended, endReason: 'toString' })).toBe(true);
  });

  it('rejects an end reason that is not text', () => {
    expect(isPauseLogEntry({ ...ended, endReason: '' })).toBe(false);
    expect(isPauseLogEntry({ ...ended, endReason: 7 })).toBe(false);
    expect(isPauseLogEntry(ended)).toBe(false);
  });

  it('rejects an entry whose end time and end reason disagree', () => {
    expect(isPauseLogEntry({ ...ended, endReason: null })).toBe(false);
    expect(isPauseLogEntry({ ...ended, endedAt: null, endReason: 'expired' })).toBe(false);
  });

  it('rejects a damaged pause or end time', () => {
    expect(isPauseLogEntry({ ...ended, endReason: 'expired', endedAt: 7 })).toBe(false);
    expect(isPauseLogEntry({ ...ended, endReason: 'expired', scope: 'tab' })).toBe(false);
    expect(isPauseLogEntry(null)).toBe(false);
  });
});

describe('pauseEndReasonLabel', () => {
  it('describes every end reason this version writes, and any other one neutrally', () => {
    for (const [reason, label] of Object.entries(PAUSE_END_REASON_LABELS)) {
      expect(pauseEndReasonLabel(reason)).toBe(label);
    }
    expect(pauseEndReasonLabel('x')).toBe('ended');
    expect(pauseEndReasonLabel('toString')).toBe('ended');
  });
});

describe('pausableHostOf', () => {
  it('returns the host of a website and null for anything else', () => {
    expect(pausableHostOf('https://Dashboard.Example.com/x?y=1')).toBe('dashboard.example.com');
    expect(pausableHostOf('http://localhost:3000/')).toBe('localhost');
    expect(pausableHostOf('chrome://extensions')).toBeNull();
    expect(pausableHostOf('chrome://newtab/')).toBeNull();
    expect(pausableHostOf('file:///tmp/a.html')).toBeNull();
    expect(pausableHostOf('about:blank')).toBeNull();
    expect(pausableHostOf(undefined)).toBeNull();
    expect(pausableHostOf('not a url')).toBeNull();
  });
});

describe('describePauseDuration', () => {
  it('says how long, in words', () => {
    expect(describePauseDuration(sitePause('example.com', 60))).toBe('for 60 minutes');
    expect(describePauseDuration(sitePause('example.com', null))).toBe('until resumed');
  });
});
