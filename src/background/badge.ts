/**
 * Action-icon badge state computation.
 *
 * Pure function form so the priority ladder can be unit-tested without
 * mocking the chrome.action API. The background calls computeBadge and
 * applies the result via chrome.action.setBadgeText/setBadgeBackgroundColor.
 *
 * Priority (highest first):
 *  1. Transient block alert (`!` red) — surfaces a block to the user even
 *     if they missed the inline toast. Auto-clears after BLOCK_BADGE_TTL_MS
 *     or when the popup opens.
 *  2. Kill switch active (`X` red).
 *  3. Active agent count (number, amber).
 *  4. Active delegation (empty, green).
 *  5. Idle (empty).
 */

export const BLOCK_BADGE_TTL_MS = 10_000;

export interface BadgeInputs {
  /** Epoch ms of the most recent block, or null when none recent. */
  lastBlockAt: number | null;
  killSwitchActive: boolean;
  agentCount: number;
  hasActiveDelegation: boolean;
}

export interface BadgeOutput {
  text: string;
  color: string;
}

export function computeBadge(inputs: BadgeInputs, now: number): BadgeOutput {
  if (
    inputs.lastBlockAt !== null
    && now - inputs.lastBlockAt < BLOCK_BADGE_TTL_MS
  ) {
    return { text: '!', color: '#ef4444' };
  }
  if (inputs.killSwitchActive) {
    return { text: 'X', color: '#ef4444' };
  }
  if (inputs.agentCount > 0) {
    return { text: String(inputs.agentCount), color: '#f59e0b' };
  }
  // Active delegation or idle — both render empty text. Color carries the
  // distinction (green when delegation is active so the icon reads as
  // "watching"; identical green when idle for visual consistency).
  return { text: '', color: '#22c55e' };
}
