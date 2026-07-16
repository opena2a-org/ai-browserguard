# ADR-009: ai-safety.txt Consumer — Reading Third-Party Domain Declarations

**Status:** Accepted
**Date:** 2026-07-16
**Refines:** ADR-006 (opt-in network features) — specifically its "the page origin
is used only as a local cache key and is never sent" constraint and the privacy
policy's "the only servers it can contact" claim.
**Constrained by:** ADR-008 (enforcement scope — display-only), ADR-003 (local-only
engineering measures, still in force).

## Context

`draft-fane-ai-safety-txt-00` defines a `/.well-known/ai-safety.txt` declaration:
a domain states, in six optional fields, whether its content is authored and
reviewed by the domain (`AI-Safe`), hardened against prompt injection
(`Injection-Protected`), served identically to agents and people
(`Consistent-Rendering`), plus `Contact`, `Attestation`, and `Last-Verified`.

**Nothing anywhere fetches or parses these files.** The format is aspirational
until a consumer exists. Exactly one declaration is known to be published
(`https://opena2a.org/.well-known/ai-safety.txt`). AI Browser Guard is the natural
first consumer: it is the component that knows an AI agent is operating on a page,
which is precisely the moment the declaration is meant to be read.

The obstacle is not the code. It is that reading a declaration requires contacting
a **third-party domain we do not control**, and every disclosure surface currently
says we contact only our own servers.

### What ADR-006 actually forbids

ADR-006 is binding on two points that a naive design walks straight through:

1. *"The page origin is used only as a local cache key and is never sent."*
2. Privacy policy §5: *"The only servers it can contact -- and only when you opt
   into the features in section 2a -- are OpenA2A's own `aim.opena2a.org` and
   `api.oa2a.org`."*

The second is the harder one. It is a **categorical claim about the set of
reachable hosts**, and a `/.well-known/` fetch expands that set to "any origin an
agent operates on." ADR-006 also warns that drift between code, privacy policy,
README, and store listing is *"a disclosure bug, not a cosmetic one."* The
extension was rejected by the Web Store once already (v0.3.0, "Purple Potassium").

### What the disclosure actually is

The roadmap framing — "this reveals the user's browsing to the domain" — is
imprecise, and the imprecision matters because it leads to over-claiming in the
policy text.

By construction (see Decision 1), the declaration is fetched **only when an agent
has been detected on that page**. The agent has already loaded the page, so the
origin's access log **already contains the visit**. The fetch does not reveal the
visit; the visit is what triggered it.

What the origin actually learns that it did not already know: **that something on
the visiting client checked for an ai-safety.txt declaration.** Correlatable by IP
and timing to the page request it already logged. That is a fingerprinting signal
— it distinguishes a client running a declaration-consuming tool from one that is
not, and a hostile origin could use it to serve declaration-aware content.

That is a real disclosure and it is why this ADR exists. It is also a materially
smaller claim than "reveals browsing," and the policy text must state the smaller
true thing rather than the larger false one.

Not verified empirically: whether Chrome attaches an identifying
`Origin: chrome-extension://<id>` header. Because `host_permissions` already
includes `<all_urls>`, the request is not treated as a CORS request and the header
is likely omitted — but we have not confirmed this against a live server, so
**every disclosure statement below is written to be true either way** and none of
them rests on that header's absence. If we later want to claim the extension is
not identifiable by name, that claim requires a server-side header capture first.

## Decision

AI Browser Guard reads `/.well-known/ai-safety.txt`, **on agent detection only**,
**default OFF**, **display-only**, and the disclosure surfaces are updated in
lockstep to state the reachable-host set accurately.

### 1. Trigger: agent detection, not navigation

The fetch hangs off the existing `DETECTION_RESULT` -> `handleDetection` path, not
a navigation listener. Consequences, all of them load-bearing:

- **No new permission.** `host_permissions: ["<all_urls>"]` is already granted (for
  the content scripts). No manifest change, so no permission-triggered Web Store
  re-review. Verified against `manifest.json` at v0.5.0.
- **Bounded key space.** Cache keys are limited to origins where an agent was
  actually detected, not every domain the user browses.
- **Narrow disclosure.** "Only while you are running an agent," not "every page you
  visit." This is what makes the policy text short and true.
- **Semantically correct.** The declaration exists to be read before an agent acts
  on the page.

A navigation trigger was rejected: it needs `webNavigation`/`tabs.onUpdated` (new
permission, re-review risk on a once-rejected extension), fetches on every domain
regardless of agent presence (widest disclosure), and produces an unbounded cache
key space.

### 2. The request reaches exactly one origin, and only that origin

The fetch is pinned so that no third party can learn anything and no other origin
can answer for the domain:

- **`redirect: 'manual'`.** A redirect is observed and rejected, never followed.
  Per draft §4 the file MUST be available at that path *on that domain*; a
  redirect means either misconfiguration or an attempt to have a different origin
  serve the declaration. This is what makes "the request reaches only the origin
  the agent already loaded" a structural guarantee rather than a hope.
  `'manual'` rather than `'error'`: both refuse to follow, but `'error'` rejects
  the promise indistinguishably from a network failure, so a canonical-redirecting
  domain would be retried forever as if it were transiently down. `'manual'`
  surfaces the redirect as an opaque response, letting it be cached as the stable
  condition it is. Accepted cost: a domain that canonical-redirects
  (`example.com` -> `www.example.com`) reads as having no declaration.
- **`credentials: 'omit'`.** No cookies. Without this the origin could tie the
  declaration check to the user's logged-in account, which would convert a weak
  fingerprint into an identified one.
- **`referrerPolicy: 'no-referrer'`.** No page URL, no referrer.
- **HTTPS-only.** A non-HTTPS page origin is skipped entirely, not upgraded. Draft
  §5.4: a declaration retrieved over an unauthenticated channel MUST NOT be treated
  as more trustworthy than one not retrieved at all — so we do not retrieve it.
  Upgrading `http://` to `https://` is also rejected: it would contact an origin
  the agent did not load.

Nothing about the page is transmitted. The request is a bare GET for a fixed path.

### 3. Fetching an attacker-controlled origin is new, and is guarded as such

Every prior network path (AIM, registry) targets a fixed, HTTPS-validated,
OpenA2A-controlled base URL. This one targets a URL derived from a hostile input.
Required, all enforced in `src/aisafety/client.ts`:

- HTTPS-only origin, parsed with `new URL()` (never string prefix matching —
  `http://localhost@attacker.com` passes a naive `startsWith`).
- `AbortSignal.timeout(5000)`.
- **Response size cap (64 KB), enforced while streaming**, not after buffering.
  A `content-length` header over the cap short-circuits; a body without or lying
  about `content-length` is capped by the reader and cancelled.
- **`Content-Type` must be `text/plain`** (parameters such as `; charset=utf-8`
  allowed). This is stricter than the draft, which makes `text/plain` a SHOULD. The
  reason is not ceremony: a very large share of sites answer unknown paths with a
  200 and an SPA/HTML fallback, and parsing that as a declaration is the most
  likely false-positive path in the whole feature. Draft §4 permits this: a
  consumer that cannot parse the file MUST behave as though no declaration exists.
- A strict parser (§3 below) with no coercion.

### 4. Display-only. No behavior is gated on a declaration.

Per ADR-008, ABG stopped stating scope it cannot deliver. A declaration is a
**self-asserted third-party claim**; draft §5.1 says so explicitly: *"A consumer
MUST NOT treat a declaration as proof of the property it asserts, and MUST NOT
relax its own defenses solely because a domain claims a favorable posture."* A
malicious domain can assert `AI-Safe: true` while serving hostile content, at zero
cost.

Therefore: the declaration is rendered in the popup and nothing else. It does not
feed a trust score, does not affect delegation, does not change enforcement, does
not touch the badge priority ladder. **Gating any behavior on a declaration value
requires its own ADR.**

We copy AIM's epistemics (`background/index.ts:657`, which refuses to feed an
`unregistered=0` into the trust average): **absence is not a negative signal.** A
domain with no declaration is displayed as unknown, never as unsafe. Nearly every
domain has no declaration; rendering that as a warning would be both wrong and
user-hostile.

`Attestation` is parsed and displayed but **not dereferenced**. Draft §5.2 says a
consumer SHOULD retrieve it, but also that it MUST confirm the record corresponds
to the domain and comes from a verifier the consumer trusts. Following an
attacker-supplied URI would contact a **second** attacker-chosen origin — a
strictly larger disclosure than this ADR authorizes, and a redirect-to-anywhere
primitive. Out of scope; needs its own ADR.

### 5. Default OFF

`DEFAULT_SETTINGS.aiSafetyTxtEnabled = false`, consistent with `aimLookupEnabled`
and `registryLookupEnabled`. `src/__tests__/fresh-install-zero-network.test.ts`
is extended to assert the new gate, so a fresh install remains provably
zero-network and the ADR-006 disclosure stays true.

### 6. Disclosure surfaces, updated in lockstep

The reachable-host set changes from "OpenA2A's own two servers" to "OpenA2A's two
servers, plus — only with this setting on, and only while an agent is detected —
the origin that agent is operating on." Per ADR-006, drift here is a disclosure
bug, so:

- **Privacy policy** (§2a, §5, §7), **README**, and the **in-popup settings
  description** are updated in this change. §7's categorical claim ("the only
  servers it can contact ... are OpenA2A's own") is removed, because it is the
  sentence this feature falsifies.
- **The store listing is deliberately NOT updated here.**
  `docs/chrome-web-store-description.md` and `docs/store-listing.md` are pinned to
  the v0.5.0 submission and describe the build that is currently live. Editing
  them now would make them claim a feature the shipped extension does not have —
  drift in the opposite direction, and just as inaccurate. The listing is updated
  at the release that first ships this, gated in `docs/testing/release-smoke.md`.
- **The rule is now enforced, not remembered.**
  `src/__tests__/network-disclosure-consistency.test.ts` fails if a boolean
  setting is neither classified local-only nor declared a network gate, if a
  network gate defaults ON, if a gate is missing from the privacy policy, or if
  the retired "only servers it can contact" claim reappears. ADR-006 asked humans
  to keep four surfaces in sync; the two that live in this repo are now held by
  CI. The store listing lives outside the repo, so it stays a manual gate.

## Consequences

### Positive
- ai-safety.txt gets its first real consumer; the format stops being aspirational.
- No manifest change, so no permission-triggered store re-review.
- The disclosure is narrower and more accurate than the roadmap assumed, and the
  policy text can say something short and true.
- `redirect: 'error'` + `credentials: 'omit'` make "reaches only the origin the
  agent already loaded, with no identity attached" a structural property.

### Negative
- The categorical "only our own servers" claim is gone. That is a real reduction in
  the strength of the privacy story, and no wording recovers it. It is the honest
  cost of consuming a decentralized format.
- A fingerprinting signal is created for opted-in users running agents.
- Canonical-redirecting and non-`text/plain` domains read as having no declaration.
  Accepted for v1; both are the safe direction to fail.

### Neutral
- ADR-003's local-only measures (self-hosted fonts, no external scripts, no
  analytics, `chrome.storage.local` only) remain in force. This ADR widens only the
  reachable-host set, and only behind an off-by-default gate.
- Chosen against: an in-memory `Map` cache. The MV3 worker unloads (~30s idle) so
  it would miss constantly, and neither existing Map has eviction. The declaration
  cache uses `chrome.storage.local` with an explicit cap and eviction.

## Future work: the zero-disclosure design

The disclosure exists only because the client fetches per-origin. It can be
removed entirely: have the Registry crawl declarations and ship the extension a
periodic digest (or bloom filter) of known-declaring domains, so there is **no
per-visit fetch at all** and the reachable-host set returns to OpenA2A's own
servers. That trades freshness and coverage for zero disclosure, needs
Registry-side crawler work, and gets its own ADR. It is the better endgame; this
ADR is the shipping step that proves the format has a consumer.

## Feedback for draft -01 (not blocking, do not edit the submitted draft)

Recorded here because implementing the first consumer surfaced them:

1. **CORS is unspecified.** A browser-based consumer without host permissions
   cannot read a declaration unless the origin sends
   `Access-Control-Allow-Origin`. The draft should say publishers SHOULD send
   `Access-Control-Allow-Origin: *`, or acknowledge that browser consumers need
   host permissions. `opena2a.org` sends it; the draft does not ask anyone to.
2. **Redirects are unspecified.** §4 says the file MUST be at that path on that
   domain but does not say what a consumer does when the path redirects,
   especially cross-origin. We chose to reject.
3. **Invalid/unsafe URI values are unspecified.** §3 says what to do with an
   invalid *boolean* (treat the field as absent) but says nothing about a
   `Contact`/`Attestation` value that is not a URI, or is a `javascript:` URI. We
   apply the boolean rule by analogy and allowlist safe schemes.
4. **Line endings are unspecified.** §3 says "each field appears on its own line"
   without defining a line terminator. A CRLF-served file breaks a naive
   LF-splitting parser: every value ends in `\r`, so every boolean becomes "any
   other value" and is silently treated as absent. We accept CRLF, CR, and LF.
