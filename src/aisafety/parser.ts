/**
 * Strict parser for `/.well-known/ai-safety.txt` declarations.
 *
 * Implements draft-fane-ai-safety-txt-00 section 3. The input is always
 * attacker-controlled: any origin an agent visits can serve arbitrary bytes at
 * this path. The parser therefore never coerces, never guesses, and never
 * infers a value for a field that is not present (draft section 3: a consumer
 * "MUST tolerate the absence of any field and MUST NOT infer a value for a
 * field that is not present").
 *
 * Absence is represented by a missing property, never by a default. A caller
 * that sees `aiSafe === undefined` knows the domain said nothing — which is not
 * the same as `aiSafe === false` ("the domain declines to make the claim").
 * Collapsing those two would be the single most damaging bug in this file.
 */

/**
 * A parsed declaration. Every field is optional (draft section 3: "All six
 * fields are OPTIONAL"). A field is present here only if the file carried it
 * AND its value was valid; an invalid value is indistinguishable from absence
 * by design (draft section 3, for booleans: "A consumer that encounters any
 * other value for a boolean field MUST treat that field as absent").
 */
export interface AiSafetyDeclaration {
  /** Domain asserts its content is authored/reviewed by it, is not
   *  user-generated, and is not published with intent to harm. Provenance and
   *  intent, NOT immunity: a domain may assert this while serving documented
   *  injection payloads, provided it declares `Injection-Protected: false`. */
  aiSafe?: boolean;
  /** Domain asserts its content is hardened against embedded prompt injection. */
  injectionProtected?: boolean;
  /** Domain declares it does not cloak (same content to agents and to people). */
  consistentRendering?: boolean;
  /** Security/abuse contact URI. */
  contact?: string;
  /** URI of an external verification record. Parsed and displayed, never
   *  dereferenced — see ADR-009 section 4. */
  attestation?: string;
  /** ISO 8601 calendar date the declaration was last verified. */
  lastVerified?: string;
}

/**
 * Schemes permitted in the `Contact` and `Attestation` URI fields.
 *
 * The draft does not constrain the scheme (section 3 gives "mailto:" and
 * "https:" only as examples), so this allowlist is consumer-side hardening
 * rather than a spec requirement — recorded as feedback item 3 in ADR-009.
 *
 * The reason is display safety. These values come from a hostile origin and end
 * up in the popup. Today they are rendered with `textContent`, so a
 * `javascript:` URI is inert; the day someone renders one as an `href` it would
 * not be. Rejecting unsafe schemes at the parse boundary means that change
 * cannot introduce the bug, because a `javascript:` or `data:` Contact never
 * survives parsing in the first place.
 */
const ALLOWED_URI_SCHEMES = new Set(['https:', 'http:', 'mailto:', 'tel:']);

/**
 * Longest URI accepted in `Contact` or `Attestation`.
 *
 * The draft sets no limit. This one is a display-integrity bound, not a parsing
 * need: a value the popup cannot show in full is a value the user cannot check,
 * and a hostile origin will happily supply 20 KB of padding to push the real
 * host out of view. Real contact and attestation URIs are far under this;
 * anything longer is treated as absent, which fails toward showing nothing
 * rather than showing something misleading.
 */
const MAX_URI_LENGTH = 255;

/** Draft section 3 defines exactly six fields. Anything else MUST be ignored. */
type FieldName =
  | 'ai-safe'
  | 'injection-protected'
  | 'consistent-rendering'
  | 'contact'
  | 'attestation'
  | 'last-verified';

const BOOLEAN_FIELDS = new Set<FieldName>([
  'ai-safe',
  'injection-protected',
  'consistent-rendering',
]);

/**
 * Parse a boolean field value.
 *
 * Draft section 3: 'Boolean fields take the value "true" or "false". A consumer
 * that encounters any other value for a boolean field MUST treat that field as
 * absent.' Only the field NAME is declared case-insensitive, so the comparison
 * here is case-sensitive: "True" is "any other value" and yields absence.
 *
 * Returns undefined for anything that is not exactly `true` or `false`.
 */
function parseBoolean(value: string): boolean | undefined {
  if (value === 'true') return true;
  if (value === 'false') return false;
  return undefined;
}

/**
 * Parse a URI field value, restricted to safe schemes.
 *
 * The draft is silent on invalid URI values, so we apply the boolean rule by
 * analogy: an unusable value is treated as absence rather than surfaced raw.
 */
function parseUri(value: string): string | undefined {
  if (value === '') return undefined;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    // Not an absolute URI. The draft requires a URI; a relative reference or
    // free text is not one.
    return undefined;
  }
  if (!ALLOWED_URI_SCHEMES.has(parsed.protocol)) return undefined;

  // Reject embedded credentials. `https://google.com@evil.com` has username
  // "google.com" and host "evil.com": it points at the attacker while reading as
  // a link to Google. A Contact or Attestation URI has no legitimate use for
  // userinfo. (Empty for mailto:/tel:, which are not hierarchical, so this does
  // not touch them.)
  //
  // This is hardening, NOT the defence against display spoofing. Padding a
  // subdomain — `https://google.com.<pad>.evil.com/` — reads the same way and
  // needs no credentials, so no parser rule closes that class. The renderer does,
  // by never truncating a value (`ai-safety-row.ts`). Do not read this line as
  // making the display safe on its own.
  if (parsed.username !== '' || parsed.password !== '') return undefined;

  // Return the PARSED form, not the raw input. `new URL()` normalises what the
  // scheme allowlist alone would let through as raw text: a unicode-confusable
  // host (Cyrillic U+0435 leading "vil.com") becomes its real punycode
  // (`https://xn--vil-qdd.com/`), an RTL-override is percent-encoded, and
  // embedded tabs/newlines are stripped. Displaying the raw string would show
  // the user something other than where the URI resolves.
  //
  // Note this punycodes legitimate IDN too (`https://münchen.de` ->
  // `https://xn--mnchen-3ya.de/`). That is the intended trade: the punycode form
  // is the unambiguous one, and rendering raw unicode is precisely what makes a
  // confusable host possible. A slightly uglier real hostname beats a
  // convincing fake one.
  const href = parsed.href;

  // Length is checked AFTER normalisation, since percent-encoding can lengthen
  // the value.
  if (href.length > MAX_URI_LENGTH) return undefined;

  return href;
}

/**
 * Parse an ISO 8601 calendar date (draft section 3: 'expressed as an ISO 8601
 * calendar date (for example, "2026-07-01")').
 *
 * Strict `YYYY-MM-DD`, and the date must actually exist. The round-trip through
 * `Date` is what rejects `2026-02-30`: `Date.parse` accepts it and rolls it
 * over to March 2, so comparing the normalized output back to the input catches
 * the rollover. A bare regex would let it through.
 */
function parseIsoDate(value: string): string | undefined {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return undefined;
  const timestamp = Date.parse(`${value}T00:00:00Z`);
  if (Number.isNaN(timestamp)) return undefined;
  // Reject rolled-over dates: 2026-02-30 parses, but normalizes to 2026-03-02.
  const normalized = new Date(timestamp).toISOString().slice(0, 10);
  if (normalized !== value) return undefined;
  return value;
}

/**
 * Parse the text of an ai-safety.txt file into a declaration.
 *
 * Never throws and never rejects a whole file: unrecognized and malformed lines
 * are ignored individually, so a file with one bad line still yields its good
 * fields (draft section 3 requires ignoring unknown field names "so that the
 * format can be extended without breaking existing consumers").
 *
 * A file with no recognized fields yields `{}`. Callers should treat that as
 * "no declaration" — see `isEmptyDeclaration`.
 */
export function parseAiSafetyTxt(text: string): AiSafetyDeclaration {
  const declaration: AiSafetyDeclaration = {};

  // Field names already encountered, tracked separately from parsed values.
  //
  // Draft section 3: "A field name SHOULD NOT appear more than once; if it
  // does, a consumer MUST use the first occurrence." The first occurrence wins
  // even when its value was INVALID and therefore produced no property. Keying
  // this off the declaration object instead would silently let a later line
  // supply the value:
  //
  //     AI-Safe: yes      <- first occurrence, invalid, field is absent
  //     AI-Safe: true     <- MUST NOT be consulted
  //
  // Using the second line there would hand an attacker a way to smuggle a value
  // past a validator by prefixing it with a deliberately invalid duplicate.
  const seenFields = new Set<string>();

  // Split on CRLF, CR, or LF. The draft says each field is on "its own line"
  // without defining a terminator (ADR-009 feedback item 4). A file served with
  // CRLF endings would otherwise leave a trailing "\r" on every value, turning
  // every boolean into "any other value" and silently emptying the declaration.
  const lines = text.split(/\r\n|\r|\n/);

  for (const line of lines) {
    // Blank lines, including whitespace-only lines, "carry no meaning and MUST
    // be ignored" (draft section 3).
    const trimmed = line.trim();
    if (trimmed === '') continue;

    // 'Lines whose first non-whitespace character is "#" are comments and MUST
    // be ignored' (draft section 3). Checked against the trimmed line so an
    // indented comment is still a comment.
    //
    // This is deliberately redundant: "# AI-Safe: true" would yield the field
    // name "# ai-safe", which the unknown-field rule below already discards, so
    // removing this line changes no output. It stays because the draft states
    // the rule explicitly and a reader should not have to derive comment
    // handling from a coincidence of the name matcher. Do not "simplify" it
    // away — and note that no test can hold it, since it has no observable
    // effect on its own.
    if (trimmed.startsWith('#')) continue;

    const colonIndex = trimmed.indexOf(':');
    if (colonIndex === -1) continue; // Not "Field: value" — not a field line.

    // Field names are case-insensitive (draft section 3).
    const name = trimmed.slice(0, colonIndex).trim().toLowerCase();
    if (name === '') continue;

    // The value is separated from the name "by a colon and optional
    // whitespace". Trailing whitespace is not addressed by the draft; we trim
    // it, because a trailing space would otherwise make an otherwise-valid
    // "true " into an absent field for no reader-visible reason.
    const value = trimmed.slice(colonIndex + 1).trim();

    // Unknown fields MUST be ignored. They are deliberately NOT recorded in
    // seenFields: the first-occurrence rule only concerns fields we define.
    if (!isKnownField(name)) continue;

    if (seenFields.has(name)) continue; // First occurrence already won.
    seenFields.add(name);

    if (BOOLEAN_FIELDS.has(name)) {
      const parsed = parseBoolean(value);
      if (parsed === undefined) continue; // Invalid boolean -> field is absent.
      switch (name) {
        case 'ai-safe':
          declaration.aiSafe = parsed;
          break;
        case 'injection-protected':
          declaration.injectionProtected = parsed;
          break;
        case 'consistent-rendering':
          declaration.consistentRendering = parsed;
          break;
      }
      continue;
    }

    switch (name) {
      case 'contact': {
        const uri = parseUri(value);
        if (uri !== undefined) declaration.contact = uri;
        break;
      }
      case 'attestation': {
        const uri = parseUri(value);
        if (uri !== undefined) declaration.attestation = uri;
        break;
      }
      case 'last-verified': {
        const date = parseIsoDate(value);
        if (date !== undefined) declaration.lastVerified = date;
        break;
      }
    }
  }

  return declaration;
}

function isKnownField(name: string): name is FieldName {
  return (
    name === 'ai-safe' ||
    name === 'injection-protected' ||
    name === 'consistent-rendering' ||
    name === 'contact' ||
    name === 'attestation' ||
    name === 'last-verified'
  );
}

/**
 * True when a parsed declaration carries no recognized field.
 *
 * Draft section 4: a consumer "that cannot parse the retrieved file MUST behave
 * as though no declaration exists for the domain." A file of pure comments, or
 * an HTML page served at this path, parses without error into `{}` — which is
 * that same "no declaration" state.
 */
export function isEmptyDeclaration(declaration: AiSafetyDeclaration): boolean {
  return Object.keys(declaration).length === 0;
}
