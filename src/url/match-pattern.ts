/**
 * Hardened glob-style URL pattern matching.
 *
 * This is the single matcher used everywhere a URL is tested against a site
 * pattern (delegation rule evaluation, the boundary monitor, and the content
 * interceptor). Each of those gates a real action, so they must agree exactly —
 * three slightly-different copies previously diverged, and none was fully
 * hardened.
 *
 * Hardening:
 *  - No ReDoS, ever, in the full-URL branch: it matches with ordered substring
 *    search (no regex), so an attacker-controllable URL of any length cannot
 *    trigger catastrophic backtracking. `*a*a*a…` against a long URL is linear.
 *  - No domain confusion in the full-URL branch: the authority (scheme://host)
 *    and the path+query are matched as separate units, so a `*` in the host part
 *    of a pattern cannot reach into the path of a different origin. Without this,
 *    `https://*.trusted.com/*` would match `https://evil.com/.trusted.com/`.
 *  - The hostname branch keeps a regex (the dot-aware `*` vs `**` semantics read
 *    clearly that way) but runs only against `new URL(url).hostname`, with a hard
 *    length cap (the URL parser does NOT enforce the 253-char DNS limit, so a
 *    crafted multi-kB "hostname" could otherwise drive `[^.]*`/`.*` backtracking);
 *    metacharacters are escaped and the wildcard count is capped.
 *  - Regex injection: in the hostname branch every metacharacter is escaped
 *    except `*`, so `(evil|trusted).com`, `ab?.com`, `[a-z]x.com`, etc. are
 *    matched literally — they cannot widen an allow pattern or shrink a block one.
 *  - Sentinel safety: a literal NUL in the pattern is stripped up front so it
 *    cannot collide with the cross-label sentinel used while building the regex.
 *
 * Semantics:
 *  - A pattern without `://` matches against the hostname only. A single `*`
 *    matches within one label (`[^.]*`, does not cross dots); `**` matches
 *    across labels (`.*`). So `*.example.com` matches `sub.example.com` but not
 *    `deep.sub.example.com`, while `**.example.com` matches both.
 *  - A pattern containing `://` matches against the full URL, with `*` matching
 *    any run of characters within its own URL part (authority or path), never
 *    across the origin boundary.
 *  - Any error (e.g. an unparseable URL) returns false. This is fail-closed for
 *    allow patterns (a non-match is "not in scope"); callers MUST validate block
 *    patterns at input time so a malformed block pattern is never silently inert.
 *
 * Limitation: the URL's host is normalized (lower-cased, IDN -> punycode) but the
 * pattern is not, so a pattern host must be written in ASCII/punycode form. A
 * Unicode-written pattern (`日本.jp`) will not match the punycoded host
 * (`xn--wgv71a.jp`). Pattern host IDN-normalization belongs at input validation;
 * until then, document ASCII/punycode patterns for internationalized hosts.
 */

/** A legitimate site pattern needs at most a couple of wildcards. Beyond this we
 *  refuse to compile the hostname regex — a pattern with this many `*` is never
 *  a real grant/block target and only courts pathological matching. */
const MAX_WILDCARDS = 4;

/** Escape every regex metacharacter EXCEPT `*` (handled by the glob passes). */
function escapeExceptStar(s: string): string {
  return s.replace(/[.+^${}()|[\]\\?]/g, '\\$&');
}

/**
 * Linear (non-backtracking) glob match where `*` matches any run of characters.
 * Implemented with ordered substring search rather than a regex, so there is no
 * catastrophic backtracking and no metacharacter injection (`?`, `(`, `.` etc.
 * are compared literally).
 */
function linearGlobMatch(text: string, pattern: string): boolean {
  const segments = pattern.split(/\*+/);
  // No wildcard at all: the text must equal the pattern exactly.
  if (segments.length === 1) return text === pattern;

  const first = segments[0];
  const last = segments[segments.length - 1];

  // Text before the first `*` is an anchored prefix; text after the last `*` is
  // an anchored suffix.
  if (!text.startsWith(first)) return false;
  if (!text.endsWith(last)) return false;

  // Each interior literal segment must appear in order, after the prefix and
  // before the suffix, without segments overlapping.
  let cursor = first.length;
  const suffixStart = text.length - last.length;
  for (let i = 1; i < segments.length - 1; i++) {
    const seg = segments[i];
    if (seg === '') continue;
    const found = text.indexOf(seg, cursor);
    if (found === -1 || found + seg.length > suffixStart) return false;
    cursor = found + seg.length;
  }
  // Prefix and suffix must not overlap (e.g. pattern `aXb*bYa` vs a short text).
  return cursor <= suffixStart;
}

/** Split a URL/pattern into its authority (`scheme://host[:port]`) and the
 *  remainder (`/path?query#frag`). The authority ends at the first `/` after
 *  `://`. Returns null if there is no `://`. */
function splitAuthority(s: string): { authority: string; path: string } | null {
  const schemeEnd = s.indexOf('://');
  if (schemeEnd === -1) return null;
  const pathStart = s.indexOf('/', schemeEnd + 3);
  if (pathStart === -1) return { authority: s, path: '' };
  return { authority: s.slice(0, pathStart), path: s.slice(pathStart) };
}

/**
 * Match a full-URL pattern (one containing `://`) against a URL.
 *
 * Matches against the browser-NORMALIZED URL (`new URL(url).href`), not the raw
 * caller-supplied string: the parser folds `\` to `/`, lowercases the host,
 * resolves userinfo/port, etc. Matching the raw string would let an agent pass
 * `https://evil.com\.trusted.com/` — whose effective host is `evil.com` — and
 * have the `*` in a `https://*.trusted.com/*` pattern span the `\`, producing a
 * false allow against a different origin. The interceptor feeds this matcher
 * un-normalized URLs (window.open arg, form.action, pushState url), so the
 * normalization MUST happen here.
 *
 * The authority (`scheme://host`) and the path are then matched as separate
 * units so a `*` in the host part cannot reach into another host's path.
 */
function matchFullUrlGlob(url: string, pattern: string): boolean {
  let href: string;
  try {
    href = new URL(url).href;
  } catch {
    return false;
  }
  const patternParts = splitAuthority(pattern);
  const urlParts = splitAuthority(href);
  if (!patternParts || !urlParts) return false;
  // Strip the trailing FQDN dot from the URL's host (at end, or before `:port`)
  // so `https://evil.com./x` cannot evade an `https://evil.com/*` pattern —
  // `evil.com.` resolves to the same server. Matching `href` (not reconstructed
  // components) keeps navigation-faithful details like a bare trailing `?`.
  const authority = urlParts.authority.replace(/\.(?=:|$)/, '');
  return (
    linearGlobMatch(authority, patternParts.authority) &&
    linearGlobMatch(urlParts.path, patternParts.path)
  );
}

export function matchUrlPattern(url: string, pattern: string): boolean {
  try {
    // NUL is never legitimate in a host/URL pattern and would collide with the
    // cross-label sentinel below; strip it before anything else.
    const stripped = pattern.replace(/\x00/g, '');

    // Collapse consecutive wildcard runs (`***` -> `**`) so a typo'd run of stars
    // doesn't trip the wildcard cap.
    const collapsed = stripped.replace(/\*{3,}/g, '**');

    if (collapsed.includes('://')) {
      return matchFullUrlGlob(url, collapsed);
    }

    // Hostname branch. Cap wildcards: against the bounded hostname a handful of
    // `**` -> `.*` expansions are fine, but an absurd count is rejected.
    if ((collapsed.match(/\*/g) ?? []).length > MAX_WILDCARDS) return false;

    // Strip a trailing FQDN dot (`evil.com.` -> `evil.com`) so it can't evade a
    // dot-less pattern.
    const hostname = new URL(url).hostname.replace(/\.$/, '');
    // The URL parser does not enforce the DNS length limit, so a crafted
    // multi-kB hostname could drive `[^.]*`/`.*` backtracking even under the
    // wildcard cap. A real hostname is <= 253 chars; reject longer ones.
    if (hostname.length > 253) return false;
    // Escape metacharacters first, then expand globs. The `**` (cross-label)
    // expansion uses a sentinel so it survives the single-`*` (within-label)
    // pass: expanding `**` -> `.*` directly would leave a `*` that the single-`*`
    // pass then corrupts into `[^.]*`, breaking cross-label matching.
    const regexStr = escapeExceptStar(collapsed)
      .replace(/\*\*/g, '\x00') // protect double-star from the single-star pass
      .replace(/\*/g, '[^.]*') //  single `*` matches within one label
      .replace(/\x00/g, '.*'); //   double `*` matches across labels
    return new RegExp(`^${regexStr}$`).test(hostname);
  } catch {
    return false;
  }
}
