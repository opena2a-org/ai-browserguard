# ADR-005: Fail-Closed Delegation Rule Evaluation

**Status:** Accepted
**Date:** 2026-02-27

## Context

The delegation system (`src/delegation/rules.ts`) enforces boundaries on
what actions an agent may perform. When an agent attempts an action, the
rule engine must decide: allow or block.

Two evaluation strategies exist:

- **Fail-open (default-allow):** If no rule explicitly blocks an action, it
  is permitted. This is simpler but dangerous for a security boundary:
  any gap in rule coverage becomes an uncontrolled pathway.
- **Fail-closed (default-deny):** If no rule explicitly allows an action,
  it is blocked. This is safer but may initially over-restrict legitimate
  agent behavior.

The delegation system defines three presets: `readOnly` (navigate and
read-dom only), `limited` (navigate, read-dom, click, type-text on
specified sites with time bounds), and `fullAccess` (all capabilities
with logging). Each preset generates an explicit `ActionRestriction[]`
that enumerates every capability with an `allow` or `block` verdict.

## Decision

Adopt fail-closed (default-deny) evaluation throughout the delegation
engine. The implementation enforces this at two levels:

1. **Action restrictions.** The `evaluateActionRestrictions` function in
   `src/delegation/rules.ts` returns `{ allowed: false }` when a
   capability is not found in the restriction list. Any capability not
   explicitly granted by the active preset is blocked.

2. **Site patterns.** The `limited` preset defaults to blocking all sites
   unless the user adds specific allow patterns. The `evaluateSitePatterns`
   function accepts a `defaultAction` parameter: for `limited` delegation,
   this is `'block'`; for `readOnly` and `fullAccess`, it is `'allow'`
   (since those presets are not site-scoped).

3. **Time bounds.** The `isTimeBoundExpired` function blocks all actions
   once a time-bounded delegation expires. There is no grace period.

4. **Inactive rules.** If `rule.isActive` is false, the `evaluateRule`
   function returns `{ allowed: false }` before checking any other
   conditions.

The kill switch (`Ctrl+Shift+K` / `Cmd+Shift+K`) revokes all delegation
tokens by setting `revoked: true`, which causes all subsequent evaluations
to deny.

## Consequences

### Positive
- No action can leak through a gap in rule definitions. If a new capability
  is added to the `AgentCapability` type but not yet mapped in a preset's
  `ActionRestriction[]`, it is blocked by default.
- Time-bound expirations are hard cutoffs. An agent cannot continue
  operating on stale permissions after the delegation window closes.
- The security posture matches user expectations for a browser guard tool:
  when in doubt, block.

### Negative
- Users may experience over-blocking when first configuring delegation,
  particularly with the `limited` preset. An agent attempting to interact
  with a site not on the allowlist is blocked without warning until the
  user adds a site pattern.
- Every new `AgentCapability` added to the system is blocked until
  explicitly included in the relevant preset's allowed list. This requires
  coordinated updates to `rules.ts` preset definitions when extending
  the capability model.

### Neutral
- Violation notifications (Chrome notification API) inform the user when
  an action is blocked, including which rule caused the denial. This
  feedback loop helps users adjust delegation rules without needing to
  understand the fail-closed model directly.
- The `DelegationToken` type includes a `revoked` field and extensible
  `scope` structure, designed for future integration with AIM delegation
  token verification (feature 386). The fail-closed model will apply
  equally to locally-issued and remotely-verified tokens.
