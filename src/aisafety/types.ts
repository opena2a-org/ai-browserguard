import type { AiSafetyDeclaration } from './parser';

/**
 * Discriminated result of an ai-safety.txt lookup.
 *
 * - `ok`: the origin served a declaration that parsed to at least one field.
 * - `none`: the origin publishes no usable declaration. A 404, a non-`text/plain`
 *   response, an oversize body, or a file that parsed to nothing all land here —
 *   draft section 4 requires a consumer that "receives any response status other
 *   than a successful one, or that cannot parse the retrieved file" to behave as
 *   though no declaration exists. These are stable conditions, so `none` is
 *   cached for the full TTL.
 * - `unreachable`: we could not check (transport error, timeout, 5xx). NOT the
 *   same as `none`: it means no signal, not "no declaration". Cached briefly so a
 *   transient outage does not turn into a per-detection stampede.
 *
 * Neither `none` nor `unreachable` is ever displayed as a negative property of
 * the domain. Absence is not a low score (ADR-009 section 4).
 */
export type AiSafetyLookupResult =
  | { status: 'ok'; declaration: AiSafetyDeclaration }
  | { status: 'none' }
  | { status: 'unreachable' };
