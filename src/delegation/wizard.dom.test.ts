/**
 * @vitest-environment jsdom
 *
 * Wizard render coverage for the piece pure-logic tests cannot see: the DOM
 * the user actually operates. The load-bearing case is block-pattern
 * authoring — `addSitePattern` always accepted `action: 'block'`, but the
 * sites-step UI hardcoded `action: 'allow'`, so no rule a real user could
 * author ever carried a block pattern and the CDP enforcement layer
 * (ruleHasBlockPattern gate) could never arm. These tests pin the UI path,
 * not the pure function.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import {
  createInitialWizardState,
  selectPreset,
  renderWizard,
  type WizardState,
} from './wizard';

/** Render the wizard into a fresh container, tracking state transitions. */
function mount(state: WizardState): {
  container: HTMLElement;
  latest: () => WizardState;
} {
  const container = document.createElement('div');
  document.body.appendChild(container);
  let current = state;
  const onStateChange = (next: WizardState): void => {
    current = next;
    renderWizard(container, next, onStateChange);
  };
  renderWizard(container, current, onStateChange);
  return { container, latest: () => current };
}

function sitesStepState(): WizardState {
  return selectPreset(createInitialWizardState(), 'limited');
}

function addPattern(container: HTMLElement, pattern: string, action: 'allow' | 'block'): void {
  const input = container.querySelector<HTMLInputElement>('input.form-input');
  const select = container.querySelector<HTMLSelectElement>('#wizard-site-action');
  const addBtn = Array.from(container.querySelectorAll('button')).find(
    (b) => b.textContent === 'Add',
  );
  expect(input, 'sites step must render a pattern input').toBeTruthy();
  expect(select, 'sites step must render an Allow/Block selector').toBeTruthy();
  expect(addBtn, 'sites step must render an Add button').toBeTruthy();
  input!.value = pattern;
  select!.value = action;
  addBtn!.click();
}

describe('wizard sites step — block-pattern authoring (ADR-007 reachability)', () => {
  it('renders an Allow/Block selector defaulting to allow', () => {
    const { container } = mount(sitesStepState());
    const select = container.querySelector<HTMLSelectElement>('#wizard-site-action');
    expect(select).toBeTruthy();
    expect(select!.value).toBe('allow');
    expect(Array.from(select!.options).map((o) => o.value)).toEqual(['allow', 'block']);
  });

  it('adds a BLOCK pattern when the user selects Block', () => {
    const { container, latest } = mount(sitesStepState());
    addPattern(container, 'blocked.test', 'block');
    expect(latest().sitePatterns).toEqual([{ pattern: 'blocked.test', action: 'block' }]);
  });

  it('adds an ALLOW pattern by default', () => {
    const { container, latest } = mount(sitesStepState());
    addPattern(container, 'allowed.test', 'allow');
    expect(latest().sitePatterns).toEqual([{ pattern: 'allowed.test', action: 'allow' }]);
  });

  it('lists each added pattern with its action', () => {
    const { container, latest } = mount(sitesStepState());
    addPattern(container, 'allowed.test', 'allow');
    addPattern(container, 'blocked.test', 'block');
    expect(latest().sitePatterns).toHaveLength(2);
    const text = container.textContent ?? '';
    expect(text).toContain('allowed.test (allow)');
    expect(text).toContain('blocked.test (block)');
  });
});

describe('wizard confirm step', () => {
  it('shows the action for every pattern in the summary', () => {
    const { container, latest } = mount(sitesStepState());
    addPattern(container, 'allowed.test', 'allow');
    addPattern(container, 'blocked.test', 'block');
    // sites -> time
    Array.from(container.querySelectorAll('button')).find((b) => b.textContent === 'Next')!.click();
    // time -> confirm (selecting a duration advances)
    Array.from(container.querySelectorAll('button')).find((b) => b.textContent === '15 minutes')!.click();
    expect(latest().currentStep).toBe('confirm');
    const text = container.textContent ?? '';
    expect(text).toContain('allowed.test (allow)');
    expect(text).toContain('blocked.test (block)');
  });

  it('renders user-typed pattern text inertly (no HTML parsing)', () => {
    const hostile = '<img src=x onerror="window.__pwned=1">';
    const { container } = mount(sitesStepState());
    addPattern(container, hostile, 'block');
    Array.from(container.querySelectorAll('button')).find((b) => b.textContent === 'Next')!.click();
    Array.from(container.querySelectorAll('button')).find((b) => b.textContent === '15 minutes')!.click();
    // The literal text must be present as TEXT, and no img element may exist.
    expect(container.textContent).toContain(hostile);
    expect(container.querySelector('img')).toBeNull();
    expect((window as unknown as { __pwned?: number }).__pwned).toBeUndefined();
  });
});

describe('wizard HTML-injection sink lock-in (extends the popup P1-1 rule)', () => {
  it('wizard.ts contains no innerHTML / outerHTML / insertAdjacentHTML / setHTMLUnsafe / document.write', () => {
    const source = readFileSync(resolve(__dirname, 'wizard.ts'), 'utf-8');
    const lines = source.split('\n');
    const banned = /\b(innerHTML|outerHTML|insertAdjacentHTML|setHTMLUnsafe)\b|\bdocument\.write\b/;
    const offenders: string[] = [];
    for (let i = 0; i < lines.length; i++) {
      const stripped = lines[i].replace(/\/\/.*$/, '').replace(/\/\*[\s\S]*?\*\//g, '');
      if (banned.test(stripped)) offenders.push(`${i + 1}: ${lines[i].trim()}`);
    }
    expect(offenders, 'wizard.ts renders popup DOM and is held to the same no-sink rule').toEqual([]);
  });
});
