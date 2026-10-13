import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import {
  SENSITIVE_URL_PATTERNS,
  createBoundaryAlert,
  classifyViolationSeverity,
  generateAlertTitle,
  generateAlertMessage,
  handleOneTimeOverride,
} from './boundary';
import type { BoundaryViolation } from '../types/events';
import { createRuleFromPreset } from '../delegation/rules';

function makeViolation(capability: import('../types/agent').AgentCapability, url: string): BoundaryViolation {
  return {
    id: 'v1',
    timestamp: new Date().toISOString(),
    agentId: 'agent-1',
    attemptedAction: capability,
    url,
    blockingRuleId: 'rule-1',
    reason: 'Blocked by delegation policy',
    userOverride: false,
  };
}

describe('classifyViolationSeverity', () => {
  it('classifies submit-form as critical', () => {
    expect(classifyViolationSeverity('submit-form', 'https://example.com')).toBe('critical');
  });

  it('classifies execute-script as critical', () => {
    expect(classifyViolationSeverity('execute-script', 'https://example.com')).toBe('critical');
  });

  it('classifies click as high', () => {
    expect(classifyViolationSeverity('click', 'https://example.com')).toBe('high');
  });

  it('classifies navigate as medium', () => {
    expect(classifyViolationSeverity('navigate', 'https://example.com')).toBe('medium');
  });

  it('classifies open-tab as low', () => {
    expect(classifyViolationSeverity('open-tab', 'https://example.com')).toBe('low');
  });

  it('upgrades severity for sensitive URLs', () => {
    expect(classifyViolationSeverity('navigate', 'https://my.bank.com')).toBe('high');
    expect(classifyViolationSeverity('click', 'https://secure.gov.uk/portal')).toBe('critical');
  });
});

/**
 * #122: the changelog entry for #109 said each level rises "on a sensitive
 * site such as a bank, payment or government site". The rule is a short list
 * of patterns looked for in the address, and most bank and government
 * addresses contain none of them, so the rule is described by its patterns.
 */
describe('a sensitive address is described by the patterns that make it one', () => {
  /** What a pattern looks for, as text: /\.bank\./i looks for ".bank.". */
  const fragment = (pattern: RegExp): string => pattern.source.replace(/\\\./g, '.');

  function read(relPath: string): string {
    return readFileSync(new URL(`../../${relPath}`, import.meta.url), 'utf-8');
  }

  /** The changelog entry on the in-page notice's "Allow once" rule (#109). */
  function changelogEntry(): string {
    const changelog = read('CHANGELOG.md');
    const start = changelog.indexOf(
      '- **The in-page block notice no longer offers "Allow once" for a high or critical severity block (#109).**',
    );
    expect(start, 'the changelog must keep its entry for #109').toBeGreaterThanOrEqual(0);
    return changelog.slice(start, changelog.indexOf('\n', start));
  }

  it('raises a text input from medium to high on an address containing any one pattern', () => {
    expect(SENSITIVE_URL_PATTERNS.map(fragment)).toEqual([
      '.bank.', '.gov.', 'paypal', 'stripe', '.financial', 'healthcare', '.mil.',
    ]);
    for (const pattern of SENSITIVE_URL_PATTERNS) {
      expect(classifyViolationSeverity('type-text', `https://example.test/x${fragment(pattern)}x`)).toBe('high');
    }
  });

  it('does not raise an address that contains none of them, such as these bank and government sites', () => {
    expect(classifyViolationSeverity('type-text', 'https://www.irs.gov/')).toBe('medium');
    expect(classifyViolationSeverity('type-text', 'https://www.chase.com/')).toBe('medium');
  });

  it('the changelog entry names each pattern and no kind of site', () => {
    const entry = changelogEntry();
    for (const pattern of SENSITIVE_URL_PATTERNS) {
      expect(entry).toContain(`\`${fragment(pattern)}\``);
    }
    expect(entry).toContain('`https://www.irs.gov/` or `https://www.chase.com/`, is not raised');
    expect(entry).not.toMatch(/such as a bank, payment or government site/i);
  });

  it('the architecture document says which addresses the patterns leave out', () => {
    expect(read('docs/architecture.md')).toContain(
      '`https://www.irs.gov/` and `https://www.chase.com/` contain none of them',
    );
  });
});

describe('generateAlertTitle', () => {
  it('returns descriptive titles for each capability', () => {
    expect(generateAlertTitle('click')).toBe('Click interaction blocked');
    expect(generateAlertTitle('submit-form')).toBe('Form submission blocked');
    expect(generateAlertTitle('navigate')).toBe('Navigation blocked');
    expect(generateAlertTitle('download-file')).toBe('File download blocked');
  });
});

describe('generateAlertMessage', () => {
  it('includes URL and rule name', () => {
    const violation = makeViolation('click', 'https://example.com/page');
    const message = generateAlertMessage(violation, 'Read-Only');
    expect(message).toContain('https://example.com/page');
    expect(message).toContain('Read-Only');
    expect(message).toContain('click');
  });

  it('includes target selector when present', () => {
    const violation = { ...makeViolation('click', 'https://example.com'), targetSelector: '#buy-btn' };
    const message = generateAlertMessage(violation, 'Test Rule');
    expect(message).toContain('#buy-btn');
  });
});

describe('createBoundaryAlert', () => {
  it('creates a complete alert from violation and rule', () => {
    const rule = createRuleFromPreset('readOnly');
    const violation = makeViolation('click', 'https://example.com');
    const alert = createBoundaryAlert(violation, rule);

    expect(alert.severity).toBe('high');
    expect(alert.title).toBe('Click interaction blocked');
    expect(alert.message).toContain('https://example.com');
    expect(alert.acknowledged).toBe(false);
  });

  it('allows one-time override for low/medium severity', () => {
    const rule = createRuleFromPreset('readOnly');
    const lowViolation = makeViolation('open-tab', 'https://example.com');
    const alert = createBoundaryAlert(lowViolation, rule);
    expect(alert.allowOneTimeOverride).toBe(true);
  });

  it('disallows one-time override for critical severity', () => {
    const rule = createRuleFromPreset('readOnly');
    const criticalViolation = makeViolation('submit-form', 'https://example.com');
    const alert = createBoundaryAlert(criticalViolation, rule);
    expect(alert.allowOneTimeOverride).toBe(false);
  });
});

describe('handleOneTimeOverride', () => {
  it('sets userOverride to true without mutating original', () => {
    const violation = makeViolation('click', 'https://example.com');
    const overridden = handleOneTimeOverride('alert-1', violation);
    expect(overridden.userOverride).toBe(true);
    expect(violation.userOverride).toBe(false);
  });
});
