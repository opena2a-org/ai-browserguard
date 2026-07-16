/**
 * Renders a site's ai-safety.txt declaration on an agent card.
 *
 * All wording and every decision about what to show lives in
 * `src/aisafety/present.ts` (pure, tested). This file only builds DOM from it —
 * the ADR-008 pattern, so the claims cannot drift per-surface.
 *
 * Deliberately plain: no colour, no icon, no badge. A colour would imply a
 * verdict, and nothing here has been verified — the site is simply telling us
 * what it says about itself. `Injection-Protected: false` is the honest answer
 * for a security-research site and must not look like a failure.
 *
 * Values come from a hostile origin, so everything is written with
 * `textContent` and never parsed as HTML (locked in by popup.dom.test.ts).
 * Nothing is rendered as a link: the parser already rejects unsafe URI schemes,
 * but display-only means display-only, and an `href` a site controls is not
 * something this feature needs.
 */

import { presentDeclaration } from '../aisafety/present';
import type { AiSafetyLookupResult } from '../aisafety/types';

/**
 * Build the declaration block for an agent card, or null when there is nothing
 * to render (no lookup result for this agent — the feature is off, or the
 * lookup has not landed yet).
 */
export function renderAiSafetyDeclaration(
  result: AiSafetyLookupResult | undefined,
): HTMLElement | null {
  if (!result) return null;

  const view = presentDeclaration(result);

  const container = document.createElement('div');
  container.className = 'ai-safety-block';
  container.style.cssText = 'margin-top: 6px; padding-top: 6px; border-top: 1px solid var(--border, #2a2a2a);';

  const heading = document.createElement('div');
  heading.style.cssText =
    'font-size: 10px; font-weight: 600; color: var(--text-secondary); text-transform: uppercase; letter-spacing: 0.06em;';
  heading.textContent = 'Site declaration';
  container.appendChild(heading);

  if (view.state !== 'declared') {
    const note = document.createElement('div');
    note.style.cssText = 'font-size: 11px; color: var(--text-secondary); margin-top: 2px;';
    note.textContent = view.note;
    note.title =
      view.state === 'none'
        ? 'This site publishes no /.well-known/ai-safety.txt declaration. Almost no sites do yet; this says nothing about the site.'
        : 'AI Browser Guard did not read a declaration for this site. Declarations are only read over HTTPS.';
    container.appendChild(note);
    return container;
  }

  for (const row of view.rows) {
    const line = document.createElement('div');
    line.style.cssText =
      'display: flex; justify-content: space-between; gap: 8px; font-size: 11px; margin-top: 2px;';
    line.title = row.hint;

    const label = document.createElement('span');
    label.style.cssText = 'color: var(--text-secondary);';
    label.textContent = row.label;

    const value = document.createElement('span');
    value.style.cssText = 'color: var(--text-primary); text-align: right; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;';
    value.textContent = row.value;

    line.appendChild(label);
    line.appendChild(value);
    container.appendChild(line);
  }

  const caveat = document.createElement('div');
  caveat.style.cssText = 'font-size: 10px; color: var(--text-secondary); margin-top: 4px; font-style: italic;';
  caveat.textContent = view.caveat;
  container.appendChild(caveat);

  return container;
}
