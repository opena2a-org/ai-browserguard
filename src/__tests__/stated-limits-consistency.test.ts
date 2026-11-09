/**
 * The storage limits the privacy policy states, checked against the values the
 * code applies.
 *
 * Every number asserted here is read from the code, not written into this file,
 * so changing a limit fails this test until the copy that states it changes
 * with it. The policy once said violation records were capped at 100 (no such
 * store exists; 100 is the detection-log cap) and that an unreachable site is
 * cached for 5 minutes (the time doubles up to a ceiling).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { DEFAULT_SETTINGS } from '../session/types';
import { MAX_RECENT_ALERTS } from '../background/handlers';
import { UNREACHABLE_CACHE_TTL_MS, UNREACHABLE_BACKOFF_CAP_MS } from '../aisafety/client';

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;

function read(relPath: string): string {
  return readFileSync(new URL(`../../${relPath}`, import.meta.url), 'utf-8');
}

/** The text of the policy list item whose bold label starts with `label`. */
function listItem(html: string, label: string): string {
  const start = html.indexOf(`<li><strong>${label}`);
  expect(start, `no list item labelled "${label}" in the policy`).toBeGreaterThanOrEqual(0);
  return html.slice(start, html.indexOf('</li>', start));
}

const policy = read('docs/privacy-policy.html');

describe('privacy policy: records kept on the device', () => {
  it('states the number of sessions the storage layer keeps', () => {
    expect(listItem(policy, 'Session logs')).toContain(
      `The last ${DEFAULT_SETTINGS.maxSessions} sessions are stored locally`,
    );
  });

  it('states the detection log cap', () => {
    expect(listItem(policy, 'Detection signals')).toContain(
      `${DEFAULT_SETTINGS.maxDetectionLogEntries} most recent detection events`,
    );
  });

  it('describes violation records as kept with the session logs and the in-memory alert list', () => {
    const item = listItem(policy, 'Violation records');
    expect(item).toContain(`last ${DEFAULT_SETTINGS.maxSessions} sessions`);
    expect(item).toContain(`${MAX_RECENT_ALERTS} most recent`);
    expect(item).toContain('not saved');
    // No separate violation store with the detection log's cap exists.
    expect(item).not.toContain(`${DEFAULT_SETTINGS.maxDetectionLogEntries} most recent`);
  });
});

describe('privacy policy: site safety declaration caching', () => {
  it('states the unreachable cache time and the ceiling it doubles up to', () => {
    const item = listItem(policy, 'Caching:');
    expect(item).toContain(
      `for ${UNREACHABLE_CACHE_TTL_MS / MINUTE_MS} minutes when the site could not be reached`,
    );
    expect(item).toContain('doubles');
    expect(item).toContain(`up to ${UNREACHABLE_BACKOFF_CAP_MS / HOUR_MS} hours`);
  });
});
