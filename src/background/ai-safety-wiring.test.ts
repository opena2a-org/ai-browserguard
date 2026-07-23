/**
 * Lock-in for the two ai-safety.txt facts that live in the service worker and
 * cannot be reached by import.
 *
 * Read the header of `src/aisafety/optout.test.ts` first: a test that asserts
 * code CONTAINS a rule cannot tell you the rule is correct, and this feature has
 * already shipped two bugs behind exactly that kind of assertion. So the scope
 * here is deliberately narrow.
 *
 * Everything decidable lives in `aisafety/optout.ts` and is asserted by outcome
 * there. What is left is one fact — *the reconcile is actually invoked* — which
 * no test can observe, because `background/index.ts` is a side-effect module
 * that registers Chrome listeners at import. Deleting the call at `initialize()`
 * left all 915 tests green: the headline privacy behaviour was enforced by
 * nothing at all.
 *
 * A source assertion is the weakest useful guard, and it is the only one
 * available for a call site. It is used here for the same reason the repo
 * already uses it for the kill-switch STATUS_QUERY field and the outbound-only
 * message types: the alternative is no guard.
 *
 * It proves the call exists. It does NOT prove the call is correct — that is
 * optout.test.ts's job, and that file drives the real cache.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const source = readFileSync(resolve(__dirname, 'index.ts'), 'utf-8');
/** Strip comments so prose about the rule cannot satisfy the rule. */
const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

describe('the opt-out reconcile is actually wired up', () => {
  it('runs on service-worker start', () => {
    // The obligation is durable and the popup that discovers it is not: its
    // warning dies with the popup, so without this call a failed opt-out delete
    // leaves declarations on disk forever with nothing aware of it.
    const initBody = code.slice(code.indexOf('function initialize()'), code.indexOf('function initialize()') + 1200);
    expect(initBody).toContain('reconcileAiSafetyStorage()');
  });

  it('runs on the periodic housekeeping tick', () => {
    // Worker-start alone is weaker than it sounds: the keepalive-ping alarm
    // exists precisely to stop this worker being torn down, so the next start
    // could be the next browser restart. The tick bounds the self-heal to the
    // alarm period.
    const alarmBody = code.slice(code.indexOf("alarm.name === 'contribute-flush'"), code.indexOf("alarm.name === 'contribute-flush'") + 800);
    expect(alarmBody).toContain('reconcileAiSafetyStorage()');
  });

  it('delegates every decision to the tested module, with no logic of its own', () => {
    // reconcileFromSettings takes zero injected dependencies now, so
    // reconcileAiSafetyStorage is pure delegation: the miswirings that shipped
    // (an always-`true` getSettings, a `clearInMemory: () => {}`) are no longer
    // even expressible here. To keep it that way this asserts the body IS the
    // delegating call and nothing else -- a tighter guard than banning the one
    // spelling `if (`, which a ternary, `&&`, `??`, or an early return all slip
    // past. Any added branch or wrong argument changes the normalized body.
    const fnStart = code.indexOf('async function reconcileAiSafetyStorage');
    expect(fnStart).toBeGreaterThan(0);
    const bodyStart = code.indexOf('{', fnStart);
    const fnBody = code.slice(bodyStart + 1, code.indexOf('\n}', fnStart));

    const normalized = fnBody.replace(/\s+/g, ' ').trim();
    expect(normalized).toBe('return reconcileFromSettings();');
  });
});

describe('the on-screen declaration write is guarded against the opt-out race', () => {
  // The decision itself (write only if the store was not cleared since capture)
  // is tested by outcome in declaration-store.test.ts. What no test can observe
  // -- enrichDomainDeclaration is in this side-effect module -- is that the write
  // actually goes through the guard, and that the generation is captured BEFORE
  // the lookup so it spans the whole in-flight window. This is a source guard,
  // the weakest useful kind, for exactly that unreachable wiring: it catches a
  // revert to the unguarded setter, or capturing the generation too late.
  const fnStart = code.indexOf('async function enrichDomainDeclaration');
  const fnBody = code.slice(fnStart, code.indexOf('\nasync function enrichAgentTrust', fnStart));

  it('writes through the guarded setter, never the unconditional one', () => {
    expect(fnBody).toContain('setDeclarationUnlessCleared(');
    // A bare setDeclaration( would be the unguarded regression the review found.
    expect(fnBody).not.toMatch(/[^a-zA-Z]setDeclaration\(/);
  });

  it('captures the clear generation before the lookup, so it spans the whole window', () => {
    const capture = fnBody.indexOf('getDeclarationClearGeneration()');
    const lookup = fnBody.indexOf('lookupAiSafetyDeclaration(');
    expect(capture).toBeGreaterThan(-1);
    expect(lookup).toBeGreaterThan(-1);
    expect(capture).toBeLessThan(lookup);
  });
});
