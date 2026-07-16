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

  it('delegates every decision to the tested module', () => {
    // reconcileAiSafetyStorage must stay dependency-injection only. An `if` here
    // is a branch in the one place no test can reach — which is how the live-vs-
    // stored count bug shipped.
    const fnStart = code.indexOf('async function reconcileAiSafetyStorage');
    expect(fnStart).toBeGreaterThan(0);
    const fnBody = code.slice(fnStart, code.indexOf('\n}', fnStart));

    expect(fnBody).toContain('reconcileFromSettings');
    expect(fnBody).not.toMatch(/\bif\s*\(/);
  });
});
