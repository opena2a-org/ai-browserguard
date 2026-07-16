/**
 * Client for `/.well-known/ai-safety.txt` declarations
 * (draft-fane-ai-safety-txt-00). See ADR-009.
 *
 * This is the first network path in the extension that contacts an origin we do
 * not control. AIM and registry lookups target a fixed, HTTPS-validated,
 * OpenA2A-owned base URL; this one targets a URL derived from wherever an agent
 * happens to be operating. Everything unusual in this file follows from that.
 *
 * The request is pinned so that it can only ever reach the one origin the agent
 * has already loaded, carries no identity, and cannot be induced to contact
 * anyone else:
 *
 *   - HTTPS only; an `http://` page is skipped, never upgraded.
 *   - `credentials: 'omit'` — no cookies, so the origin cannot tie the check to
 *     the user's logged-in account.
 *   - `redirect: 'manual'` — a redirect is observed and rejected, never followed.
 *   - `referrerPolicy: 'no-referrer'` — no page URL leaves the browser.
 *   - 5s timeout, 64 KB streaming cap, strict `text/plain` check, strict parse.
 *
 * The target origin is trustworthy input in one narrow sense worth stating,
 * because the whole SSRF question turns on it: `originUrl` is
 * `window.location.href` read in the content script's ISOLATED world
 * (`src/content/index.ts:144`), which page JS cannot forge, and the message
 * handler requires a real `sender.tab`. So the origin here is always one the
 * browser has already loaded — this code cannot be pointed at an internal host
 * the user never visited.
 */

import { parseAiSafetyTxt, isEmptyDeclaration } from './parser';
import { readCachedLookup, writeCachedLookup } from './cache';
import { getSettings } from '../session/storage';
import type { AiSafetyLookupResult } from './types';

const WELL_KNOWN_PATH = '/.well-known/ai-safety.txt';

const DEFAULT_TIMEOUT_MS = 5000;

/**
 * Cache TTL for a settled answer (`ok` or `none`).
 *
 * Long on purpose. Declarations are near-static — `Last-Verified` is a date, not
 * a timestamp — and every expiry is another request to a third-party origin.
 * Here the TTL is a privacy control, not a latency knob (ADR-009): a longer TTL
 * is strictly fewer fingerprintable requests. Staleness costs little because the
 * feature is display-only and gates no behavior.
 */
const DEFAULT_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Cache TTL for `unreachable`. Short enough to recover when an origin comes
 * back, long enough to stop a broken origin from being re-hit on every
 * detection. Longer than AIM's 30s equivalent because nothing here is urgent.
 */
const UNREACHABLE_CACHE_TTL_MS = 5 * 60 * 1000;

/**
 * Maximum bytes read from the response body. The one known real declaration is
 * ~1.7 KB; 64 KB leaves room for a heavily commented file while bounding what a
 * hostile origin can make us buffer.
 */
const MAX_BODY_BYTES = 64 * 1024;

/**
 * The origin whose declaration we may fetch for a page URL, or null if we must
 * not fetch at all.
 *
 * Parsed with `new URL()` rather than string matching: `https://evil.com#@x` and
 * `http://localhost@attacker.com` both defeat naive prefix checks (the same
 * reasoning as `aim/client.ts:48`). `.origin` also strips any userinfo.
 *
 * Non-HTTPS pages return null and are skipped entirely rather than upgraded to
 * HTTPS. Draft section 5.4: a consumer "MUST NOT treat a declaration retrieved
 * over an unauthenticated channel as more trustworthy than one that was not
 * retrieved at all" — so there is no value in retrieving it. Upgrading to
 * `https://` would be worse still: it would contact an origin the agent never
 * loaded, which is exactly the disclosure ADR-009 rules out.
 */
export function declarationOriginFor(pageUrl: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(pageUrl);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:') return null;
  return parsed.origin;
}

/**
 * Read a response body, refusing to buffer more than `maxBytes`.
 *
 * A `content-length` over the cap short-circuits before any body is read. That
 * header is a hostile-controlled hint though — it can be absent (chunked) or
 * simply lie — so the stream is independently capped and cancelled the moment it
 * runs over. Buffering first and checking the length afterwards would be the
 * whole DoS.
 *
 * Falls back to `response.text()` when the body is not a stream, which keeps the
 * function usable against simple response mocks.
 */
async function readCappedText(response: Response, maxBytes: number): Promise<string | null> {
  const declaredLength = response.headers.get('content-length');
  if (declaredLength !== null) {
    const length = Number(declaredLength);
    if (Number.isFinite(length) && length > maxBytes) return null;
  }

  const body = response.body;
  if (!body || typeof body.getReader !== 'function') {
    const text = await response.text();
    return new TextEncoder().encode(text).byteLength > maxBytes ? null : text;
  }

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => { /* already tearing down */ });
        return null;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock?.();
  }

  const joined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  // Non-fatal decoding: the draft says the file is UTF-8, but a malformed byte
  // should degrade to a replacement character and let the strict parser reject
  // the affected line, not throw away an otherwise valid declaration.
  return new TextDecoder('utf-8').decode(joined);
}

/**
 * True when the response carries the `text/plain` media type.
 *
 * Stricter than the draft, which makes `text/plain` a SHOULD (section 4). The
 * reason is concrete: a large share of sites answer unknown paths with 200 and
 * an SPA/HTML shell, and treating that as a declaration is the most likely
 * false-positive path in this feature. Draft section 4 permits the strictness —
 * a consumer that cannot parse the file must behave as though none exists.
 * A missing header is treated the same as a wrong one.
 */
function isPlainText(response: Response): boolean {
  const header = response.headers.get('content-type');
  if (header === null) return false;
  const mediaType = header.split(';')[0]?.trim().toLowerCase();
  return mediaType === 'text/plain';
}

/**
 * Whether the user has opted into reading declarations.
 *
 * The gate lives INSIDE this function, not only at the call site, which differs
 * from how `aimLookupEnabled` gates `aim/client.ts` (there, `enrichAgentTrust`
 * checks and the client is unaware). The difference is deliberate and worth the
 * small inconsistency: the background service worker is a side-effect module
 * that tests cannot import, so a call-site-only gate can only ever be tested by
 * asserting the DEFAULT VALUE — never that the code respects it. Every other
 * network path here targets an OpenA2A server; this one contacts a site we do
 * not control, and ADR-006 calls a regression in this disclosure a bug rather
 * than a cosmetic issue. So the guarantee is made where a test can reach it:
 * `fresh-install-zero-network.test.ts` calls the real entry point with the real
 * default settings and proves no request leaves the browser.
 *
 * Fails CLOSED: if the setting cannot be read, we contact no one. An unreadable
 * setting is not consent.
 */
async function isEnabled(): Promise<boolean> {
  try {
    const settings = await getSettings();
    return settings.aiSafetyTxtEnabled === true;
  } catch {
    return false;
  }
}

/**
 * Look up the ai-safety.txt declaration for the origin of `pageUrl`.
 *
 * Returns `unreachable` when the feature is off: the setting means "do not
 * contact this site", which leaves us with no information — it is not a claim
 * that the site has no declaration.
 *
 * Never throws. Callers get `unreachable` for "could not check" and `none` for
 * "no usable declaration"; neither is a negative signal about the domain.
 */
export async function lookupAiSafetyDeclaration(
  pageUrl: string,
  options?: { timeoutMs?: number; cacheTtlMs?: number; maxBytes?: number },
): Promise<AiSafetyLookupResult> {
  if (!(await isEnabled())) return { status: 'unreachable' };

  const origin = declarationOriginFor(pageUrl);
  // Not an HTTPS page: we cannot check. Not cached — no network was touched and
  // the answer is free to recompute. Reported as `unreachable`, not `none`:
  // the domain may well publish a declaration; we declined to read it.
  if (origin === null) return { status: 'unreachable' };

  const cached = await readCachedLookup(origin);
  if (cached !== null) return cached;

  const ttl = options?.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
  const maxBytes = options?.maxBytes ?? MAX_BODY_BYTES;

  const settle = async (
    result: AiSafetyLookupResult,
    ttlMs: number,
  ): Promise<AiSafetyLookupResult> => {
    // Re-check consent before storing anything.
    //
    // The gate was checked before the fetch, up to 5 seconds ago. If the user
    // opted out while it was in flight, the opt-out's delete has already run —
    // and writing now would put a declaration back on disk moments after they
    // revoked consent. The periodic reconcile would remove it, but only on the
    // next tick, and the privacy policy says opting out deletes stored
    // declarations, not that it deletes them within five minutes.
    //
    // Returns `unreachable` rather than the result, so the revoked lookup also
    // reaches no display. The network request itself already went out — that
    // cannot be recalled — but nothing it produced is kept.
    if (!(await isEnabled())) return { status: 'unreachable' };
    await writeCachedLookup(origin, result, ttlMs);
    return result;
  };

  let response: Response;
  try {
    response = await fetch(`${origin}${WELL_KNOWN_PATH}`, {
      method: 'GET',
      credentials: 'omit',
      redirect: 'manual',
      referrerPolicy: 'no-referrer',
      headers: { Accept: 'text/plain' },
      signal: AbortSignal.timeout(options?.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    });
  } catch {
    // Transport error or timeout. No signal — short negative cache.
    return settle({ status: 'unreachable' }, UNREACHABLE_CACHE_TTL_MS);
  }

  // A redirect is never followed. Draft section 4 requires the file to be at
  // this path ON that domain, so a redirect means either misconfiguration or an
  // attempt to have some other origin answer for this one. `redirect: 'manual'`
  // surfaces it as an opaque redirect (type 'opaqueredirect', status 0) rather
  // than a rejection, which lets us cache it as the stable condition it is
  // instead of retrying it as if it were a transient failure.
  if (response.type === 'opaqueredirect' || (response.status >= 300 && response.status < 400)) {
    return settle({ status: 'none' }, ttl);
  }

  // No declaration published. Stable, so it gets the full TTL — this is the
  // overwhelmingly common case and must not generate repeat traffic.
  if (response.status === 404 || response.status === 410) {
    return settle({ status: 'none' }, ttl);
  }

  // Any other non-success (5xx, 403, ...). Draft section 4 says to behave as
  // though no declaration exists, which we do — but these can be transient, so
  // they are recorded as `unreachable` and retried sooner.
  if (!response.ok) {
    return settle({ status: 'unreachable' }, UNREACHABLE_CACHE_TTL_MS);
  }

  if (!isPlainText(response)) {
    return settle({ status: 'none' }, ttl);
  }

  let text: string | null;
  try {
    text = await readCappedText(response, maxBytes);
  } catch {
    return settle({ status: 'unreachable' }, UNREACHABLE_CACHE_TTL_MS);
  }
  // Over the size cap: a stable property of what this origin serves, not a
  // transient fault.
  if (text === null) return settle({ status: 'none' }, ttl);

  const declaration = parseAiSafetyTxt(text);
  if (isEmptyDeclaration(declaration)) {
    return settle({ status: 'none' }, ttl);
  }

  return settle({ status: 'ok', declaration }, ttl);
}
