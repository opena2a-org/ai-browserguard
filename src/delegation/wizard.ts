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
 * Add a site pattern to the wizard configuration.
 */
export function addSitePattern(state: WizardState, pattern: SitePattern): WizardState {
  if (!pattern.pattern.trim()) {
    return { ...state, errors: ['Pattern cannot be empty.'] };
  }

  // Check for duplicates
  const exists = state.sitePatterns.some((p) => p.pattern === pattern.pattern);
  if (exists) {
    return { ...state, errors: ['This pattern already exists.'] };
  }

  return {
    ...state,
    sitePatterns: [...state.sitePatterns, pattern],
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
  container.innerHTML = '';

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
  heading.textContent = 'Add sites the agent can access (glob patterns):';
  container.appendChild(heading);

  // Input row
  const inputRow = document.createElement('div');
  inputRow.style.cssText = 'display: flex; gap: 6px; margin-bottom: 8px;';

  const input = document.createElement('input');
  input.type = 'text';
  input.placeholder = 'e.g., *.example.com';
  input.className = 'form-input';
  input.style.cssText = 'flex: 1;';

  const addBtn = document.createElement('button');
  addBtn.className = 'btn btn-primary';
  addBtn.textContent = 'Add';
  addBtn.style.cssText = 'padding: 4px 12px; font-size: 12px;';
  addBtn.addEventListener('click', () => {
    const value = input.value.trim();
    if (value) {
      onStateChange(addSitePattern(state, { pattern: value, action: 'allow' }));
      input.value = '';
    }
  });

  inputRow.appendChild(input);
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

  let html = `<p><strong>Preset:</strong> ${info.title}</p>`;
  if (state.sitePatterns.length > 0) {
    html += `<p><strong>Sites:</strong> ${state.sitePatterns.map((p) => p.pattern).join(', ')}</p>`;
  }
  if (state.durationMinutes) {
    const opt = TIME_DURATION_OPTIONS.find((o) => o.minutes === state.durationMinutes);
    html += `<p><strong>Duration:</strong> ${opt?.label ?? state.durationMinutes + ' minutes'}</p>`;
  }
  summary.innerHTML = html;
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
