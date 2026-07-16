/**
 * Pairing a stored declaration with the agent it actually describes.
 *
 * The background worker keys declarations by tabId, which is NOT sufficient on
 * its own to say which site a result describes. A tab keeps its id across a
 * navigation, and this extension has no navigation listener at all, so:
 *
 *   1. An agent is detected on https://evil.example; its declaration is stored
 *      under tab 5, claiming AI-Safe.
 *   2. The tab navigates to https://mybank.com. Detection re-fires and swaps
 *      `activeAgents` synchronously, while the new lookup is still in flight
 *      (up to the 5s timeout).
 *   3. A STATUS_QUERY in that window would map tab 5 to the new agent and hand
 *      back the OLD site's declaration — rendering evil.example's safety claims
 *      on a card for an agent operating on mybank.com.
 *
 * So a result is stored with the origin it was read from, and is surfaced only
 * while that origin still matches the agent's current one. Attributing one
 * site's self-assessment to another is precisely the overclaim ADR-008 exists to
 * prevent, and it is worse here than a missing row: a stale "Claimed" is a
 * statement about a site that never made it.
 *
 * Lives outside `background/index.ts` so it can be tested directly — that module
 * is a side-effect service worker a test cannot import — and so the STATUS_QUERY
 * handler stays compact enough for the kill-switch lock-in test that scans it.
 */

import { declarationOriginFor } from './client';
import type { AiSafetyLookupResult } from './types';

export interface StoredDeclaration {
  /**
   * The origin this result describes, or null when the page was not HTTPS and
   * we declined to read it.
   *
   * Null is a real value, not a missing one, and must compare equal to the null
   * re-derived from the same page URL — otherwise the honest "could not check"
   * state is silently dropped as a mismatch instead of being shown.
   */
  origin: string | null;
  result: AiSafetyLookupResult;
}

/** Minimal shape needed from an agent; avoids importing the full identity type. */
interface AgentLike {
  id: string;
  originUrl: string;
}

/**
 * The declaration for an agent, or undefined when the stored one describes a
 * different origin (or there is none).
 */
export function declarationForAgent(
  entry: StoredDeclaration | undefined,
  agentOriginUrl: string,
): AiSafetyLookupResult | undefined {
  if (!entry) return undefined;
  if (entry.origin !== declarationOriginFor(agentOriginUrl)) return undefined;
  return entry.result;
}

/**
 * Build the agent-id-keyed declaration map the popup consumes.
 *
 * Re-keys from tabId (how the worker stores them) to agent id (how the popup
 * renders cards), dropping any entry whose origin no longer matches.
 */
export function collectAiSafetyDeclarations(
  activeAgents: Map<number, AgentLike>,
  stored: Map<number, StoredDeclaration>,
): Record<string, AiSafetyLookupResult> {
  const byAgentId: Record<string, AiSafetyLookupResult> = {};
  for (const [tabId, agent] of activeAgents) {
    const result = declarationForAgent(stored.get(tabId), agent.originUrl);
    if (result) byAgentId[agent.id] = result;
  }
  return byAgentId;
}
