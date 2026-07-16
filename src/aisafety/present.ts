/**
 * Single source of truth for how an ai-safety.txt declaration is described to
 * the user.
 *
 * Pure, so the wording is tested rather than trusted. This mirrors
 * `src/delegation/enforceability.ts` (ADR-008), and for the same reason: the
 * last time this extension let each surface phrase a claim for itself, the
 * surfaces drifted into stating more than the implementation delivered.
 *
 * Two rules govern every string in this file.
 *
 * 1. **A declaration is a claim, not a finding.** Draft section 5.1: a consumer
 *    "MUST NOT treat a declaration as proof of the property it asserts". Any
 *    site can publish `AI-Safe: true` at zero cost, including a hostile one.
 *    So the vocabulary here is "claimed" / "not claimed", never "safe" /
 *    "unsafe", and the caveat is not optional decoration.
 * 2. **Absence is not a negative signal.** A site with no declaration is
 *    reported as exactly that, never as a risk. Nearly every site on the web has
 *    no declaration; rendering that as a warning would be both wrong and, per
 *    the house UX rule, shaming the user for the state of the web.
 *
 * There is deliberately no severity, score, or colour in this model. A colour
 * implies a verdict, and we have not verified anything. `Injection-Protected:
 * false` is the honest answer for a security-research site that publishes
 * payloads on purpose — it must not render as a failure.
 */

import type { AiSafetyLookupResult } from './types';

export interface DeclarationRow {
  /** Short label for the field. */
  label: string;
  /** The site's claim, already put into words. */
  value: string;
  /** Plain-language definition of the field, for a title/tooltip. */
  hint: string;
}

export type DeclarationView =
  /** The site published a declaration with at least one usable field. */
  | { state: 'declared'; rows: DeclarationRow[]; caveat: string }
  /** The site publishes no usable declaration. Not a criticism of the site. */
  | { state: 'none'; note: string }
  /** We did not or could not check. Distinct from "there is none". */
  | { state: 'unchecked'; note: string };

const CAVEAT = 'Self-asserted by this site and not verified. Any site can publish any claim.';

const CLAIMED = 'Claimed';
const NOT_CLAIMED = 'Not claimed';

/**
 * `true` means the site makes the claim; `false` means it explicitly declines to
 * (draft section 3: 'A value of "false" asserts that the domain does not make
 * the claim, and is the correct value for any domain that is unsure').
 *
 * A field the site omitted produces no row at all, which is what keeps
 * "said nothing" distinguishable from "said no" on screen.
 */
function claim(value: boolean): string {
  return value ? CLAIMED : NOT_CLAIMED;
}

const HINTS = {
  aiSafe:
    'The site states its content is authored or reviewed by the site, is not user-generated, and is not published with intent to harm. This asserts intent, not immunity: a site may claim it while deliberately publishing injection payloads as research.',
  injectionProtected:
    'The site states its content is hardened against prompt-injection payloads embedded in the pages it serves.',
  consistentRendering:
    'The site states it serves identical content to AI agents and to people, and does not cloak.',
  contact: 'A security or abuse contact published by the site.',
  attestation:
    'An external verification record the site points to. AI Browser Guard displays the link but does not open it.',
  lastVerified: 'The date the site says it last verified this declaration.',
} as const;

/**
 * Turn a lookup result into the exact rows and wording the UI renders.
 */
export function presentDeclaration(result: AiSafetyLookupResult): DeclarationView {
  if (result.status === 'unreachable') {
    // Covers both "not an HTTPS page, so we declined to read it" and "the
    // request failed". Either way we have no information, which is not the same
    // as the site having no declaration — so we must not say it has none.
    return { state: 'unchecked', note: 'Could not check this site' };
  }

  if (result.status === 'none') {
    return { state: 'none', note: 'No declaration published' };
  }

  const { declaration } = result;
  const rows: DeclarationRow[] = [];

  // Field order follows the draft, so the file and the UI read the same way.
  if (declaration.aiSafe !== undefined) {
    rows.push({
      label: 'Site-authored content',
      value: claim(declaration.aiSafe),
      hint: HINTS.aiSafe,
    });
  }
  if (declaration.injectionProtected !== undefined) {
    rows.push({
      label: 'Injection-hardened',
      value: claim(declaration.injectionProtected),
      hint: HINTS.injectionProtected,
    });
  }
  if (declaration.consistentRendering !== undefined) {
    rows.push({
      label: 'Consistent rendering',
      value: claim(declaration.consistentRendering),
      hint: HINTS.consistentRendering,
    });
  }
  if (declaration.contact !== undefined) {
    rows.push({ label: 'Contact', value: declaration.contact, hint: HINTS.contact });
  }
  if (declaration.attestation !== undefined) {
    rows.push({ label: 'Attestation', value: declaration.attestation, hint: HINTS.attestation });
  }
  if (declaration.lastVerified !== undefined) {
    rows.push({ label: 'Last verified', value: declaration.lastVerified, hint: HINTS.lastVerified });
  }

  // A declaration that parsed but produced no renderable row is, to the user,
  // the same as no declaration. The client already filters this case; handling
  // it here too means no caller can render an empty, caveat-only block.
  if (rows.length === 0) return { state: 'none', note: 'No declaration published' };

  return { state: 'declared', rows, caveat: CAVEAT };
}
