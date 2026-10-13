/**
 * @vitest-environment jsdom
 *
 * Every Full Access grant expires after FULL_ACCESS_MAX_MINUTES (rules.ts), so
 * each place that describes the preset to a user must state that limit. The
 * README and store copy once called it "Unrestricted" / "Everything allowed"
 * with "boundary alerts", though nothing is outside the grant for an alert to
 * fire on, and only the agent-card button named the limit.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { FULL_ACCESS_MAX_MINUTES } from '../delegation/rules';
import { createInitialWizardState, renderWizard } from '../delegation/wizard';

// Resolved from __dirname: under the jsdom environment import.meta.url is not
// a file: URL, so the URL-relative form used by node-environment tests fails.
function read(relPath: string): string {
  return readFileSync(resolve(__dirname, '../..', relPath), 'utf-8');
}

/** The single line of `relPath` that describes Full Access, found by `marker`. */
function fullAccessLine(relPath: string, marker: string): string {
  const lines = read(relPath).split('\n').filter((l) => l.includes(marker));
  expect(lines, `${relPath} must describe Full Access on exactly one line containing "${marker}"`).toHaveLength(1);
  return lines[0];
}

function wizardFullAccessDescription(): string {
  const container = document.createElement('div');
  renderWizard(container, createInitialWizardState(), () => {});
  const card = Array.from(container.querySelectorAll('.preset-card')).find(
    (c) => c.querySelector('strong')?.textContent === 'Full Access',
  );
  expect(card, 'the preset step must render a Full Access card').toBeTruthy();
  return card!.querySelector('p')?.textContent ?? '';
}

const SURFACES: Array<[string, () => string]> = [
  ['README.md delegation presets table', () => fullAccessLine('README.md', '| Full Access |')],
  ['docs/chrome-web-store-description.md', () => fullAccessLine('docs/chrome-web-store-description.md', 'Full Access (')],
  ['docs/store-listing.md', () => fullAccessLine('docs/store-listing.md', '- Full Access:')],
  ['docs/store-description-v0.5.0.txt', () => fullAccessLine('docs/store-description-v0.5.0.txt', 'Full Access (')],
  ['wizard preset description', wizardFullAccessDescription],
];

describe('Full Access descriptions state its time limit', () => {
  it.each(SURFACES)('%s names the limit', (_name, text) => {
    expect(text()).toContain(`${FULL_ACCESS_MAX_MINUTES} minutes`);
  });

  it.each(SURFACES)('%s does not describe it as unbounded or as raising boundary alerts', (_name, text) => {
    const t = text();
    expect(t).not.toMatch(/unrestricted/i);
    expect(t).not.toMatch(/everything allowed/i);
    expect(t).not.toMatch(/boundary alerts remain active/i);
    expect(t).not.toMatch(/with boundary alerts|logging and alerts/i);
  });
});
