/**
 * Delegation wizard UI logic.
 *
 * Manages the 3-preset delegation wizard that appears in the popup.
 */

import type { DelegationPreset, DelegationRule, SitePattern } from '../types/delegation';
import { createRuleFromPreset } from './rules';

export type WizardStep = 'preset' | 'sites' | 'time' | 'confirm';

export interface WizardState {
  currentStep: WizardStep;
  selectedPreset: DelegationPreset | null;
  sitePatterns: SitePattern[];
  durationMinutes: number | null;
  label: string;
  errors: string[];
}

export const TIME_DURATION_OPTIONS = [
  { label: '15 minutes', minutes: 15 },
  { label: '1 hour', minutes: 60 },
  { label: '4 hours', minutes: 240 },
] as const;

export function createInitialWizardState(): WizardState {
  return {
    currentStep: 'preset',
    selectedPreset: null,
    sitePatterns: [],
    durationMinutes: null,
    label: '',
    errors: [],
  };
}

/**
 * Select a delegation preset and determine the next step.
 */
export function selectPreset(state: WizardState, preset: DelegationPreset): WizardState {
  const nextStep: WizardStep = preset === 'limited' ? 'sites' : 'confirm';
  return {
    ...state,
    selectedPreset: preset,
    currentStep: nextStep,
    errors: [],
  };
}

/**
 * Normalize + validate a user-typed BLOCK pattern into the effective pattern
 * set to store, or an error string.
 *
 * `url/match-pattern.ts` states in binding language that callers "MUST validate
 * block patterns at input time so a malformed block pattern is never silently
 * inert" — because the matcher fail-CLOSES (returns false) on a non-match, and
 * for a *block* a non-match is fail-OPEN (the request the user meant to block
 * sails through). This is the input-time gate the wizard is the first and only
 * author of block patterns, so it owns:
 *
 *  - **Host-level, not URL-level.** A browser-layer block is tab-wide and
 *    host-scoped. A `scheme://host` pattern with no path matches NO real request
 *    (`https://evil.com` never matches `https://evil.com/steal`), and a
 *    path-scoped block is not meaningfully enforceable off-realm — so any URL is
 *    reduced to its host (scheme, userinfo, port, path stripped).
 *  - **Reject the inert / over-broad.** Empty, a lone `*`/`**` (would block the
 *    tab's own resources), a path/whitespace, or more wildcards than the matcher
 *    will compile (all silently inert or catastrophic) are refused with a
 *    plain-language reason instead of being stored as a false sense of safety.
 *  - **Cover subdomains for a plain host.** A bare `evil.com` matches only the
 *    apex; the store copy promises the domain is blocked and users expect
 *    `www.evil.com` blocked too. A plain host expands to `evil.com` + the
 *    cross-label `**.evil.com`. An explicit wildcard is respected as typed.
 */
export function normalizeBlockPattern(input: string): { patterns: SitePattern[] } | { error: string } {
  const badDomain = 'Enter a plain domain to block, e.g. ads.example.com.';
  const tooBroad = 'That would block almost every site. Name a specific domain, e.g. ads.example.com.';

  // Canonicalize to exactly what the matcher will COMPARE against, not just
  // check the shape: the matcher lowercases and trailing-dot-strips the request
  // HOST but never the pattern, so a pattern that differs in case or a trailing
  // dot is silently inert (fail-open for a block). Lowercase up front.
  let host = input.trim().toLowerCase();
  if (!host) return { error: 'Pattern cannot be empty.' };

  const schemeIdx = host.indexOf('://');
  if (schemeIdx !== -1) {
    host = host.slice(schemeIdx + 3);
    // Authority ends at the first path separator. WHATWG folds `\` to `/` for
    // special schemes, so BOTH end it — cutting only on `/` would parse
    // `https://evil.com\@x.com` as host `x.com` while the browser sees `evil.com`.
    const cut = host.search(/[/\\]/);
    if (cut !== -1) host = host.slice(0, cut);
    const at = host.lastIndexOf('@');
    if (at !== -1) host = host.slice(at + 1);
  }
  // A :port never survives into `new URL(url).hostname`, so a pattern carrying
  // one is inert — block the host regardless of port.
  host = host.replace(/:\d+$/, '');
  // Trim leading/trailing dots (FQDN / cookie-domain artifacts) and collapse
  // over-long `*` runs, so the string equals what the matcher compiles.
  host = host.replace(/^\.+|\.+$/g, '').replace(/\*{3,}/g, '**');

  if (!host) return { error: badDomain };
  if (/[/\\\s]/.test(host)) return { error: badDomain };
  if ((host.match(/\*/g) ?? []).length > 4) return { error: tooBroad };

  const labels = host.split('.');
  // The registrable tail (last two labels) must be literal, so a wildcard can
  // never sit on the TLD: this rejects `**`, `*`, `**.*`, `*.com`, `**.com`,
  // `*.*.*.*` — each of which matches a public-suffix-wide swath and would brick
  // the delegated tab — while still allowing `*.evil.com` / `**.evil.com`.
  if (labels.length < 2 || labels.slice(-2).some((l) => l.includes('*'))) {
    return { error: tooBroad };
  }
  // Every LITERAL label must be valid DNS syntax (1–63 chars, no leading/
  // trailing hyphen, no empty label from `a..b`); `*`/`**` labels are wildcards.
  for (const label of labels) {
    if (label === '*' || label === '**') continue;
    if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)) {
      return { error: badDomain };
    }
  }

  if (host.includes('*')) {
    // Explicit wildcard: respect the user's scope as typed (not inert — the
    // literal-tail rule and label grammar above ruled that out).
    return { patterns: [{ pattern: host, action: 'block' }] };
  }
  // Plain host: block the apex AND every subdomain.
  return {
    patterns: [
      { pattern: host, action: 'block' },
      { pattern: `**.${host}`, action: 'block' },
    ],
  };
}

/**
 * Add a site pattern to the wizard configuration. Block patterns are normalized
 * and validated at input time (see normalizeBlockPattern); a plain-host block
 * expands to apex + subdomains, so one input can yield more than one pattern.
 * Allow patterns are stored as typed — the matcher fail-CLOSES for allow, so an
 * inert allow is a usability, not a safety, issue.
 */
export function addSitePattern(state: WizardState, pattern: SitePattern): WizardState {
  const raw = pattern.pattern.trim();
  if (!raw) {
    return { ...state, errors: ['Pattern cannot be empty.'] };
  }

  let toAdd: SitePattern[];
  if (pattern.action === 'block') {
    const norm = normalizeBlockPattern(raw);
    if ('error' in norm) {
      return { ...state, errors: [norm.error] };
    }
    toAdd = norm.patterns;
  } else {
    toAdd = [{ pattern: raw, action: 'allow' }];
  }

  const existing = new Set(state.sitePatterns.map((p) => `${p.action}:${p.pattern}`));
  const fresh = toAdd.filter((p) => !existing.has(`${p.action}:${p.pattern}`));
  if (fresh.length === 0) {
    return { ...state, errors: ['This pattern already exists.'] };
  }

  return {
    ...state,
    sitePatterns: [...state.sitePatterns, ...fresh],
    errors: [],
  };
}

/**
 * Remove a site pattern by index.
 */
export function removeSitePattern(state: WizardState, index: number): WizardState {
  const sitePatterns = state.sitePatterns.filter((_, i) => i !== index);
  return { ...state, sitePatterns, errors: [] };
}

/**
 * Set the time duration for the limited preset.
 */
export function setDuration(state: WizardState, minutes: number): WizardState {
  const valid = TIME_DURATION_OPTIONS.some((opt) => opt.minutes === minutes);
  if (!valid) {
    return { ...state, errors: ['Invalid duration. Choose 15 minutes, 1 hour, or 4 hours.'] };
  }
  return { ...state, durationMinutes: minutes, errors: [] };
}

/**
 * Advance to the next wizard step.
 */
export function nextStep(state: WizardState): WizardState {
  switch (state.currentStep) {
    case 'preset':
      if (!state.selectedPreset) {
        return { ...state, errors: ['Select a delegation preset.'] };
      }
      if (state.selectedPreset === 'limited') {
        return { ...state, currentStep: 'sites', errors: [] };
      }
      return { ...state, currentStep: 'confirm', errors: [] };

    case 'sites':
      if (state.sitePatterns.length === 0) {
        return { ...state, errors: ['Add at least one site pattern.'] };
      }
      return { ...state, currentStep: 'time', errors: [] };

    case 'time':
      if (state.durationMinutes === null) {
        return { ...state, errors: ['Select a time duration.'] };
      }
      return { ...state, currentStep: 'confirm', errors: [] };

    case 'confirm':
      return state;

    default:
      return state;
  }
}

/**
 * Go back to the previous wizard step.
 */
export function previousStep(state: WizardState): WizardState {
  const stepOrder: WizardStep[] = ['preset', 'sites', 'time', 'confirm'];
  const currentIndex = stepOrder.indexOf(state.currentStep);

  if (currentIndex <= 0) return state;

  // For readOnly/fullAccess, go back from confirm to preset
  if (state.currentStep === 'confirm' && state.selectedPreset !== 'limited') {
    return { ...state, currentStep: 'preset', errors: [] };
  }

  return { ...state, currentStep: stepOrder[currentIndex - 1], errors: [] };
}

/**
 * Finalize the wizard and create a delegation rule.
 */
export function finalizeWizard(state: WizardState): DelegationRule | null {
  if (!state.selectedPreset) return null;

  if (state.selectedPreset === 'limited') {
    if (state.sitePatterns.length === 0) return null;
    if (state.durationMinutes === null) return null;
  }

  return createRuleFromPreset(state.selectedPreset, {
    sitePatterns: state.sitePatterns,
    durationMinutes: state.durationMinutes ?? undefined,
    label: state.label || undefined,
  });
}

const PRESET_DESCRIPTIONS: Record<DelegationPreset, { title: string; description: string }> = {
  readOnly: {
    title: 'Read-Only',
    description: 'Blocks clicking, typing, and form submission for in-page automation (best-effort). External CDP agents (Playwright, Computer Use, etc.) bypass this -- use the kill switch to close the tab.',
  },
  limited: {
    title: 'Limited Access',
    description: 'Agent can interact with specific sites you choose, with a time limit.',
  },
  fullAccess: {
    title: 'Full Access',
    description: 'Agent can perform any action. All activity is logged with boundary alerts.',
  },
};

/**
 * Render the wizard UI into a container element.
 */
export function renderWizard(
  container: HTMLElement,
  state: WizardState,
  onStateChange: (newState: WizardState) => void
): void {
  container.replaceChildren();

  // Error display
  if (state.errors.length > 0) {
    const errorDiv = document.createElement('div');
    errorDiv.className = 'wizard-errors';
    errorDiv.style.cssText = 'color: var(--danger); font-size: 12px; margin-bottom: 8px;';
    errorDiv.textContent = state.errors.join(' ');
    container.appendChild(errorDiv);
  }

  switch (state.currentStep) {
    case 'preset':
      renderPresetStep(container, state, onStateChange);
      break;
    case 'sites':
      renderSitesStep(container, state, onStateChange);
      break;
    case 'time':
      renderTimeStep(container, state, onStateChange);
      break;
    case 'confirm':
      renderConfirmStep(container, state, onStateChange);
      break;
  }
}

function renderPresetStep(
  container: HTMLElement,
  state: WizardState,
  onStateChange: (newState: WizardState) => void
): void {
  const presets: DelegationPreset[] = ['readOnly', 'limited', 'fullAccess'];
  for (const preset of presets) {
    const info = PRESET_DESCRIPTIONS[preset];
    const card = document.createElement('button');
    card.type = 'button';
    card.className = `preset-card${state.selectedPreset === preset ? ' selected' : ''}`;

    const title = document.createElement('strong');
    title.textContent = info.title;

    const desc = document.createElement('p');
    desc.style.cssText = 'margin: 4px 0 0; font-size: 11px; color: var(--text-secondary);';
    desc.textContent = info.description;

    card.appendChild(title);
    card.appendChild(desc);
    card.addEventListener('click', () => {
      onStateChange(selectPreset(state, preset));
    });
    container.appendChild(card);
  }
}

function renderSitesStep(
  container: HTMLElement,
  state: WizardState,
  onStateChange: (newState: WizardState) => void
): void {
  const heading = document.createElement('p');
  heading.style.cssText = 'font-size: 12px; color: var(--text-secondary); margin-bottom: 8px;';
  heading.textContent = 'Add sites the agent can access, and sites to block (glob patterns):';
  container.appendChild(heading);

  // Input row
  const inputRow = document.createElement('div');
  inputRow.style.cssText = 'display: flex; gap: 6px; margin-bottom: 8px;';

  const input = document.createElement('input');
  input.type = 'text';
  input.placeholder = 'e.g., *.example.com';
  input.className = 'form-input';
  input.style.cssText = 'flex: 1;';

  // Allow/Block selector. Block patterns are what the browser-layer (CDP)
  // enforcement acts on — without this control no rule a user can author ever
  // carries one, and that layer can never arm.
  const actionSelect = document.createElement('select');
  actionSelect.className = 'form-input';
  actionSelect.id = 'wizard-site-action';
  actionSelect.style.cssText = 'width: 76px;';
  for (const action of ['allow', 'block'] as const) {
    const opt = document.createElement('option');
    opt.value = action;
    opt.textContent = action === 'allow' ? 'Allow' : 'Block';
    actionSelect.appendChild(opt);
  }

  const addBtn = document.createElement('button');
  addBtn.className = 'btn btn-primary';
  addBtn.textContent = 'Add';
  addBtn.style.cssText = 'padding: 4px 12px; font-size: 12px;';
  addBtn.addEventListener('click', () => {
    const value = input.value.trim();
    const action = actionSelect.value === 'block' ? 'block' : 'allow';
    if (value) {
      onStateChange(addSitePattern(state, { pattern: value, action }));
      input.value = '';
    }
  });

  inputRow.appendChild(input);
  inputRow.appendChild(actionSelect);
  inputRow.appendChild(addBtn);
  container.appendChild(inputRow);

  // Pattern list
  for (let i = 0; i < state.sitePatterns.length; i++) {
    const p = state.sitePatterns[i];
    const row = document.createElement('div');
    row.style.cssText = 'display: flex; justify-content: space-between; align-items: center; padding: 4px 0; font-size: 12px;';
    const label = document.createElement('span');
    label.style.cssText = 'color: var(--text-primary);';
    label.textContent = `${p.pattern} (${p.action})`;
    row.appendChild(label);
    const removeBtn = document.createElement('button');
    removeBtn.className = 'btn btn-secondary';
    removeBtn.textContent = 'Remove';
    removeBtn.style.cssText = 'padding: 2px 8px; font-size: 11px;';
    removeBtn.addEventListener('click', () => onStateChange(removeSitePattern(state, i)));
    row.appendChild(removeBtn);
    container.appendChild(row);
  }

  // Nav buttons
  renderNavButtons(container, state, onStateChange);
}

function renderTimeStep(
  container: HTMLElement,
  state: WizardState,
  onStateChange: (newState: WizardState) => void
): void {
  const heading = document.createElement('p');
  heading.style.cssText = 'font-size: 12px; color: var(--text-secondary); margin-bottom: 8px;';
  heading.textContent = 'How long should the delegation last?';
  container.appendChild(heading);

  for (const option of TIME_DURATION_OPTIONS) {
    const btn = document.createElement('button');
    btn.className = `btn ${state.durationMinutes === option.minutes ? 'btn-primary' : 'btn-secondary'}`;
    btn.textContent = option.label;
    btn.style.cssText = 'display: block; width: 100%; margin-bottom: 6px;';
    btn.addEventListener('click', () => {
      const updated = setDuration(state, option.minutes);
      onStateChange(nextStep(updated));
    });
    container.appendChild(btn);
  }

  renderNavButtons(container, state, onStateChange, true);
}

function renderConfirmStep(
  container: HTMLElement,
  state: WizardState,
  onStateChange: (newState: WizardState) => void
): void {
  const preset = state.selectedPreset;
  if (!preset) return;

  const info = PRESET_DESCRIPTIONS[preset];
  const summary = document.createElement('div');
  summary.style.cssText = 'font-size: 12px; color: var(--text-secondary);';

  // Built with textContent, never innerHTML: pattern text is user-typed and
  // must not reach an HTML-parsing sink (same no-sink rule popup.ts is held to).
  const addSummaryRow = (label: string, value: string): void => {
    const p = document.createElement('p');
    const strong = document.createElement('strong');
    strong.textContent = `${label}: `;
    p.appendChild(strong);
    p.appendChild(document.createTextNode(value));
    summary.appendChild(p);
  };

  addSummaryRow('Preset', info.title);
  if (state.sitePatterns.length > 0) {
    addSummaryRow('Sites', state.sitePatterns.map((p) => `${p.pattern} (${p.action})`).join(', '));
  }
  if (state.durationMinutes) {
    const opt = TIME_DURATION_OPTIONS.find((o) => o.minutes === state.durationMinutes);
    addSummaryRow('Duration', opt?.label ?? state.durationMinutes + ' minutes');
  }
  container.appendChild(summary);

  // Label input
  const labelInput = document.createElement('input');
  labelInput.type = 'text';
  labelInput.placeholder = 'Label (optional)';
  labelInput.className = 'form-input';
  labelInput.value = state.label;
  labelInput.style.cssText = 'width: 100%; margin: 8px 0;';
  labelInput.addEventListener('input', () => {
    state.label = labelInput.value;
  });
  container.appendChild(labelInput);

  // Activate button
  const activateBtn = document.createElement('button');
  activateBtn.className = 'btn btn-primary';
  activateBtn.textContent = 'Activate Delegation';
  activateBtn.style.cssText = 'width: 100%; margin-top: 8px;';
  activateBtn.addEventListener('click', () => {
    const rule = finalizeWizard(state);
    if (rule) {
      // Dispatch custom event for popup to pick up
      container.dispatchEvent(
        new CustomEvent('delegation-activated', { detail: rule, bubbles: true })
      );
    }
  });
  container.appendChild(activateBtn);

  renderNavButtons(container, state, onStateChange, true);
}

function renderNavButtons(
  container: HTMLElement,
  state: WizardState,
  onStateChange: (newState: WizardState) => void,
  showBack = false
): void {
  const nav = document.createElement('div');
  nav.style.cssText = 'display: flex; justify-content: space-between; margin-top: 8px;';

  if (showBack) {
    const backBtn = document.createElement('button');
    backBtn.className = 'btn btn-secondary';
    backBtn.textContent = 'Back';
    backBtn.style.cssText = 'font-size: 11px;';
    backBtn.addEventListener('click', () => onStateChange(previousStep(state)));
    nav.appendChild(backBtn);
  }

  if (state.currentStep === 'sites') {
    const nextBtn = document.createElement('button');
    nextBtn.className = 'btn btn-primary';
    nextBtn.textContent = 'Next';
    nextBtn.style.cssText = 'font-size: 11px; margin-left: auto;';
    nextBtn.addEventListener('click', () => onStateChange(nextStep(state)));
    nav.appendChild(nextBtn);
  }

  if (nav.children.length > 0) {
    container.appendChild(nav);
  }
}
