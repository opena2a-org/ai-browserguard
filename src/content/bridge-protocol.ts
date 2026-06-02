/**
 * Shared message-type constants for the ISOLATED-world ↔ MAIN-world bridge.
 *
 * The bridge uses a one-shot `MessageChannel` handshake: ISOLATED creates a
 * `MessageChannel`, transfers `port2` to MAIN via a single `window.postMessage`
 * with `port2` in the transfer list. After that exchange, BOTH sides detach
 * their `window` 'message' listeners and all subsequent traffic flows through
 * the entangled `MessagePort` pair.
 *
 * Why MessageChannel instead of nonce-on-postMessage: a malicious page can
 * register `window.addEventListener('message', ...)` and read the nonce off
 * the wire, then forge subsequent messages with the same nonce. After
 * MessageChannel transfer, traffic on the port is not visible to any other
 * `window` listener.
 *
 * Defense relies on document_start execution order. Both content scripts in
 * `manifest.json` declare `run_at: "document_start"`. ISOLATED is declared
 * first and runs first; it queues the bootstrap via `window.postMessage`,
 * MAIN loads next and registers its one-shot bootstrap listener
 * synchronously, then the queued task dispatches. No page script can attach
 * a `'message'` listener before this exchange because page parsing has not
 * advanced past document_start.
 */

/** Envelope sent by ISOLATED to MAIN with `port2` in the transfer list. */
export const MSG_BRIDGE_BOOTSTRAP = 'AI_GUARD:BRIDGE_BOOTSTRAP';

/** Delegation-rule update broadcast from ISOLATED to MAIN. */
export const MSG_RULE_UPDATE = 'AI_GUARD:RULE_UPDATE';

/** Action report from MAIN to ISOLATED (intercepted capability attempt). */
export const MSG_ACTION = 'AI_GUARD:ACTION';

/** One-shot capability override from ISOLATED to MAIN (toast / notification). */
export const MSG_ALLOW_ONCE = 'AI_GUARD:ALLOW_ONCE';

/** CDP automation detected via stack-trace trap, from MAIN to ISOLATED. */
export const MSG_CDP_DETECTED = 'AI_GUARD:CDP_DETECTED';

/** Network event observed by MAIN-world fetch/XHR wrapper. */
export const MSG_NETWORK_EVENT = 'AI_GUARD:NETWORK_EVENT';

/** Kill-switch hard-block sentinel state from ISOLATED to MAIN (P1-2). */
export const MSG_KILL_SWITCH = 'AI_GUARD:KILL_SWITCH';

/** Shape of every port message exchanged after bootstrap. */
export interface BridgeMessage {
  type: string;
  [key: string]: unknown;
}

/** Shape of the one-shot bootstrap envelope on `window.postMessage`. */
export interface BridgeBootstrapEnvelope {
  type: typeof MSG_BRIDGE_BOOTSTRAP;
}
