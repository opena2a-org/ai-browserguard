/**
 * A declaration must never be attributed to the wrong site.
 *
 * The background worker keys declarations by tabId, but a tab KEEPS its id
 * across a navigation and this extension has no navigation listener at all. So
 * tabId alone cannot establish which site a stored declaration describes:
 *
 *   1. Agent detected on https://evil.example -> its declaration is cached under
 *      tab 5, claiming AI-Safe.
 *   2. The tab navigates to https://mybank.com. Detection re-fires and swaps
 *      `activeAgents` SYNCHRONOUSLY, while the new lookup is still in flight
 *      (up to the 5s timeout).
 *   3. A STATUS_QUERY in that window maps tab 5 -> the new agent -> the OLD
 *      site's declaration, and the popup renders evil.example's safety claims
 *      on a card for an agent operating on mybank.com.
 *
 * The fix is to store the origin a result was read from and surface it only when
 * it still matches the agent's current origin. These tests exercise the real
 * pairing functions the STATUS_QUERY handler calls, not a copy of the rule.
 */
import { describe, it, expect } from 'vitest';
import { declarationForAgent, collectAiSafetyDeclarations } from './attribution';
import type { StoredDeclaration } from './attribution';
import type { AiSafetyLookupResult } from './types';

type StoredEntry = StoredDeclaration;

const EVIL_DECLARATION: AiSafetyLookupResult = {
  status: 'ok',
  declaration: { aiSafe: true, injectionProtected: true },
};

describe('a declaration is only shown for the origin it came from', () => {
  it('does not attribute one site\'s claims to an agent now on another site', () => {
    // The core regression. Keying on tabId alone renders this as
    // "Site-authored content: Claimed" on the mybank.com card.
    const stored: StoredEntry = { origin: 'https://evil.example', result: EVIL_DECLARATION };
    expect(declarationForAgent(stored, 'https://mybank.com/account')).toBeUndefined();
  });

  it('shows the declaration when the origin still matches', () => {
    const stored: StoredEntry = { origin: 'https://evil.example', result: EVIL_DECLARATION };
    expect(declarationForAgent(stored, 'https://evil.example/some/page')).toEqual(EVIL_DECLARATION);
  });

  it('matches on origin, not on full URL', () => {
    // A path change within the same site is not a navigation to a new origin.
    const stored: StoredEntry = { origin: 'https://example.com', result: EVIL_DECLARATION };
    expect(declarationForAgent(stored, 'https://example.com/a?b=1#c')).toEqual(EVIL_DECLARATION);
  });

  it('treats a port change as a different origin', () => {
    const stored: StoredEntry = { origin: 'https://example.com', result: EVIL_DECLARATION };
    expect(declarationForAgent(stored, 'https://example.com:8443/')).toBeUndefined();
  });

  it('treats a subdomain as a different origin', () => {
    const stored: StoredEntry = { origin: 'https://example.com', result: EVIL_DECLARATION };
    expect(declarationForAgent(stored, 'https://evil.example.com/')).toBeUndefined();
  });

  it('does not match an http page against an https declaration', () => {
    const stored: StoredEntry = { origin: 'https://example.com', result: EVIL_DECLARATION };
    expect(declarationForAgent(stored, 'http://example.com/')).toBeUndefined();
  });
});

describe('collectAiSafetyDeclarations (what STATUS_QUERY returns)', () => {
  const agentOnBank = { id: 'agent-bank', originUrl: 'https://mybank.com/account' };
  const agentOnEvil = { id: 'agent-evil', originUrl: 'https://evil.example/x' };

  it('re-keys from tabId to agent id', () => {
    const agents = new Map([[5, agentOnEvil]]);
    const stored = new Map<number, StoredEntry>([
      [5, { origin: 'https://evil.example', result: EVIL_DECLARATION }],
    ]);
    expect(collectAiSafetyDeclarations(agents, stored)).toEqual({ 'agent-evil': EVIL_DECLARATION });
  });

  it('drops a declaration left over from the tab\'s previous site', () => {
    // Tab 5 was on evil.example, is now on mybank.com; the new lookup has not
    // landed. The popup must show nothing for this agent, not evil's claims.
    const agents = new Map([[5, agentOnBank]]);
    const stored = new Map<number, StoredEntry>([
      [5, { origin: 'https://evil.example', result: EVIL_DECLARATION }],
    ]);
    expect(collectAiSafetyDeclarations(agents, stored)).toEqual({});
  });

  it('does not leak one tab\'s declaration onto another tab\'s agent', () => {
    const agents = new Map([[5, agentOnEvil], [6, agentOnBank]]);
    const stored = new Map<number, StoredEntry>([
      [5, { origin: 'https://evil.example', result: EVIL_DECLARATION }],
    ]);
    const out = collectAiSafetyDeclarations(agents, stored);
    expect(out).toEqual({ 'agent-evil': EVIL_DECLARATION });
    expect(out['agent-bank']).toBeUndefined();
  });

  it('is empty when the feature is off (nothing stored)', () => {
    const agents = new Map([[5, agentOnEvil]]);
    expect(collectAiSafetyDeclarations(agents, new Map())).toEqual({});
  });
});

describe('the non-HTTPS "could not check" state still renders', () => {
  it('pairs a null origin with a non-HTTPS page', () => {
    // null is a real value here ("we declined to read this"), not a missing one.
    // Storing '' instead would fail this comparison and silently drop the
    // honest "Could not check this site" row.
    const stored: StoredEntry = { origin: null, result: { status: 'unreachable' } };
    expect(declarationForAgent(stored, 'http://example.com/page')).toEqual({
      status: 'unreachable',
    });
  });

  it('does not pair a null origin with an https page', () => {
    const stored: StoredEntry = { origin: null, result: { status: 'unreachable' } };
    expect(declarationForAgent(stored, 'https://example.com/page')).toBeUndefined();
  });
});
