/**
 * In-memory, per-worker store of the ai-safety.txt result for each detected
 * agent's tab.
 *
 * This lives in its own importable module rather than as a field on the
 * background service worker's `state` for one specific reason: the opt-out
 * reconcile must be able to empty it, and the reconcile is a pure, imported,
 * outcome-tested module. A field on `state` can only be reached from there by
 * injecting a `() => state.x.clear()` closure -- and a closure passed in from a
 * side-effect module that no test can import is exactly the miswiring
 * (`clearInMemory: () => {}`) that shipped and survived the whole suite. Bound
 * by import, there is nothing to pass and nothing to get wrong, and the clear is
 * assertable by outcome (write an entry, opt out, assert the store is empty).
 *
 * Keyed by tabId, sharing `activeAgents`' lifecycle and pruned by the same
 * tab-removal path. A tabId alone is NOT a safe attribution key: there is no
 * navigation listener in this extension, so a tab keeps its id across a
 * navigation to a different site, and detection re-fires and swaps `activeAgents`
 * synchronously while the new lookup is still in flight. So each result is stored
 * WITH the origin it was read from, and `collectAiSafetyDeclarations`
 * (attribution.ts) surfaces it only while that origin still matches the agent's
 * current one.
 *
 * Not persisted: rebuilt from live detections and empty on every worker start.
 */

import type { StoredDeclaration } from './attribution';

const declarations = new Map<number, StoredDeclaration>();

/** Record the lookup result for a tab's detected agent. */
export function setDeclaration(tabId: number, entry: StoredDeclaration): void {
  declarations.set(tabId, entry);
}

/** Drop a tab's entry (tab closed, or its agent changed). */
export function deleteDeclaration(tabId: number): void {
  declarations.delete(tabId);
}

/**
 * Empty the store. Called on opt-out (directly, and by the reconcile), so that
 * nothing the feature gathered remains on screen after consent is revoked.
 */
export function clearInMemoryDeclarations(): void {
  declarations.clear();
}

/** The live map, for the attribution reader that re-keys it to agent ids. */
export function getInMemoryDeclarations(): Map<number, StoredDeclaration> {
  return declarations;
}

/** How many entries are held. Test/diagnostic helper. */
export function inMemoryDeclarationCount(): number {
  return declarations.size;
}
