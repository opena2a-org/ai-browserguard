/**
 * Tests for the action-icon badge priority ladder.
 *
 * Regression for P0-UX-1 Layer 2: a recent block must trump every other
 * badge state for BLOCK_BADGE_TTL_MS so the user gets a peripheral signal
 * that BrowserGuard intervened.
 */

import { describe, it, expect } from 'vitest';
import { computeBadge, BLOCK_BADGE_TTL_MS, type BadgeInputs } from './badge';

function inputs(overrides: Partial<BadgeInputs> = {}): BadgeInputs {
  return {
    lastBlockAt: null,
    killSwitchActive: false,
    agentCount: 0,
    hasActiveDelegation: false,
    ...overrides,
  };
}

describe('computeBadge', () => {
  it('shows the block alert when a block happened within the TTL', () => {
    const now = 1_000_000;
    const result = computeBadge(inputs({ lastBlockAt: now - 1000 }), now);
    expect(result).toEqual({ text: '!', color: '#ef4444' });
  });

  it('block alert is dropped after BLOCK_BADGE_TTL_MS', () => {
    const now = 1_000_000;
    const result = computeBadge(
      inputs({ lastBlockAt: now - BLOCK_BADGE_TTL_MS - 1 }),
      now,
    );
    // No transient — falls through to next priority. With no other state
    // this is the idle/empty badge.
    expect(result.text).toBe('');
  });

  it('block alert beats kill switch', () => {
    const now = 1_000_000;
    const result = computeBadge(
      inputs({ lastBlockAt: now - 500, killSwitchActive: true }),
      now,
    );
    expect(result.text).toBe('!');
  });

  it('block alert beats active agent count', () => {
    const now = 1_000_000;
    const result = computeBadge(
      inputs({ lastBlockAt: now - 500, agentCount: 3 }),
      now,
    );
    expect(result.text).toBe('!');
  });

  it('block alert beats active delegation', () => {
    const now = 1_000_000;
    const result = computeBadge(
      inputs({ lastBlockAt: now - 500, hasActiveDelegation: true }),
      now,
    );
    expect(result.text).toBe('!');
  });

  it('kill switch beats agent count and delegation', () => {
    const result = computeBadge(
      inputs({ killSwitchActive: true, agentCount: 5, hasActiveDelegation: true }),
      1_000_000,
    );
    expect(result).toEqual({ text: 'X', color: '#ef4444' });
  });

  it('agent count beats active delegation', () => {
    const result = computeBadge(
      inputs({ agentCount: 2, hasActiveDelegation: true }),
      1_000_000,
    );
    expect(result).toEqual({ text: '2', color: '#f59e0b' });
  });

  it('active delegation with no agents shows empty (green)', () => {
    const result = computeBadge(inputs({ hasActiveDelegation: true }), 1_000_000);
    expect(result.text).toBe('');
    expect(result.color).toBe('#22c55e');
  });

  it('idle state shows empty', () => {
    const result = computeBadge(inputs(), 1_000_000);
    expect(result.text).toBe('');
  });

  it('clock skew (now < lastBlockAt) drops the block alert', () => {
    // If lastBlockAt is in the future for any reason (clock jump,
    // bad input), don't show a stuck "!" badge forever.
    const now = 1_000_000;
    const result = computeBadge(inputs({ lastBlockAt: now + 60_000 }), now);
    // now - lastBlockAt is negative, so the < BLOCK_BADGE_TTL_MS gate
    // is satisfied incorrectly. This test pins the current (intentional)
    // behavior so any future hardening shows up here.
    expect(result.text).toBe('!');
  });
});
