/**
 * #69: what the popup offers for a recorded block, and the removal of the
 * content toast's inert "Whitelist" action.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { blockingRuleIdOf, isCapabilityBlock, CAPABILITY_BLOCK_HINT } from './block-actions';
import type { BoundaryAlert } from '../alerts/boundary';

function alert(attemptedAction: string, blockingRuleId: string): BoundaryAlert {
  return {
    violation: { attemptedAction, blockingRuleId, url: 'https://example.com/x' },
  } as unknown as BoundaryAlert;
}

describe('block-actions', () => {
  it('treats a download block as capability-level (no site Allow offered)', () => {
    expect(isCapabilityBlock(alert('download-file', 'r1'))).toBe(true);
    expect(CAPABILITY_BLOCK_HINT).toMatch(/Full Access permits downloads/);
  });

  it('offers a site Allow for site-level blocks', () => {
    expect(isCapabilityBlock(alert('navigate', 'r1'))).toBe(false);
    expect(isCapabilityBlock(alert('submit-form', 'r1'))).toBe(false);
  });

  it('targets the rule that blocked the action, or the session rule when none is recorded', () => {
    expect(blockingRuleIdOf(alert('navigate', 'rule-42'))).toBe('rule-42');
    expect(blockingRuleIdOf(alert('navigate', 'none'))).toBeUndefined();
    expect(blockingRuleIdOf(alert('navigate', ''))).toBeUndefined();
  });

  it('popup.ts routes both Allow buttons through the checked path', () => {
    const popup = readFileSync(resolve(__dirname, 'popup.ts'), 'utf-8');
    expect(popup).not.toMatch(/sendToBackground\('DOMAIN_WHITELIST', \{ domain(: d)? \}\)/);
    expect(popup.match(/sendWhitelist\(/g)?.length).toBeGreaterThanOrEqual(3);
  });
});

describe('content toast', () => {
  it('offers no Whitelist action (DOMAIN_WHITELIST is popup-only; the button was inert)', () => {
    const src = readFileSync(resolve(__dirname, '..', 'content', 'index.ts'), 'utf-8')
      .replace(/\/\/.*$/gm, '')
      .replace(/\/\*[\s\S]*?\*\//g, '');
    expect(src).not.toMatch(/onWhitelist\s*:/);
    expect(src).not.toMatch(/'DOMAIN_WHITELIST'/);
  });
});
