/**
 * Enforcement-scope claims, held to the scope the README states.
 *
 * ADR-008 narrowed what the extension says it enforces: per-action blocking
 * applies to in-page / injected automation only and is best-effort, a download
 * is cancelled only in an agent's tab while Browser-layer blocking holds a
 * session there (which it does under any delegation that withholds
 * `download-file`, with or without a blocked site), and the kill switch closes
 * the tabs an agent controls without ending an external CDP session. The
 * README and the store listing were
 * reworded then; the package description, the privacy policy and the
 * architecture overview kept the older sentences ("blocks their scripted
 * navigations, form submissions, and downloads", "kill switch to terminate
 * agent access").
 *
 * So: no surface that says what the extension does may carry an unscoped
 * blocking or kill-switch claim, and each summary that did must state the
 * scope. A reader of any one of them should not come away expecting more than
 * the build enforces.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';

function read(relPath: string): string {
  return readFileSync(new URL(`../../${relPath}`, import.meta.url), 'utf-8');
}

/**
 * The text from `start` up to `end`. Throws when either marker is missing, so
 * a renamed heading fails the test instead of emptying what it checks.
 */
function between(doc: string, start: string, end: string): string {
  const from = doc.indexOf(start);
  const to = from === -1 ? -1 : doc.indexOf(end, from + start.length);
  if (from === -1 || to === -1) {
    throw new Error(`Marker not found: ${from === -1 ? start : end}`);
  }
  return doc.slice(from, to);
}

const pkg = JSON.parse(read('package.json')) as { description: string };
const manifest = JSON.parse(read('manifest.json')) as { description: string };
const privacyPolicy = read('docs/privacy-policy.html');
const architecture = read('docs/architecture.md');

/** Every surface that tells a reader what the extension does. */
const SURFACES: Array<[string, string]> = [
  ['package.json description', pkg.description],
  ['manifest.json description', manifest.description],
  ['README.md', read('README.md')],
  ['docs/privacy-policy.html', privacyPolicy],
  ['docs/architecture.md', architecture],
  ['docs/store-listing.md', read('docs/store-listing.md')],
  ['docs/chrome-web-store-description.md', read('docs/chrome-web-store-description.md')],
];

/** The summaries that state what is blocked and what the kill switch does. */
const SUMMARIES: Array<[string, string]> = [
  ['package.json description', pkg.description],
  [
    'privacy policy section 1',
    between(privacyPolicy, '<h2>1. What This Extension Does</h2>', '<h2>2. '),
  ],
  [
    'architecture system overview',
    between(architecture, '## 1. System Overview', 'The extension consists of'),
  ],
];

/** The statements of what the kill switch does that have room for its limit. */
const KILL_SWITCH_STATEMENTS: Array<[string, string]> = [
  SUMMARIES[1],
  [
    'architecture kill switch section',
    between(architecture, '## 5. Kill Switch Mechanism', '### Activation Triggers'),
  ],
];

describe('no surface makes an unscoped enforcement claim', () => {
  it.each(SURFACES)('%s does not say every agent is blocked', (_name, text) => {
    // "blocks their scripted navigations, ..." -- "their" is every detected
    // agent, including the external CDP frameworks whose native input the page
    // realm cannot intercept.
    expect(text).not.toMatch(/\bblocks?\s+their\b/i);
  });

  it.each(SURFACES)('%s does not say the kill switch ends agent access', (_name, text) => {
    // It closes tabs and revokes delegations. An external driver keeps its
    // CDP session and can reopen a tab.
    expect(text).not.toMatch(/terminates?\s+agent\s+access/i);
    expect(text).not.toMatch(/revocation\s+of\s+all\s+agent\s+access/i);
  });
});

describe('each summary states the scope the README states', () => {
  it.each(SUMMARIES)('%s scopes blocking to in-page automation, best-effort', (_name, text) => {
    expect(text).toMatch(/in-page/i);
    expect(text).toMatch(/best[- ]effort/i);
  });

  it.each(SUMMARIES)(
    "%s ties a cancelled download to the agent's tab and Browser-layer blocking",
    (_name, text) => {
      expect(text).toMatch(/download/i);
      expect(text).toMatch(/agent's tab/i);
      expect(text).toMatch(/Browser-layer blocking/i);
    },
  );

  it.each(SUMMARIES)(
    '%s does not make a cancelled download depend on a blocked site',
    (_name, text) => {
      // The session that reports a download starting in an agent's tab attaches
      // under any delegation that withholds `download-file`, with or without a
      // blocked site. A summary may mention a blocked site only to say it is
      // not required.
      const mentions = text.match(/[^.;:]*\bblocks?\s+a\s+site\b/gi) ?? [];
      for (const clause of mentions) {
        expect(clause).toMatch(/whether or not|does not have to/i);
      }
    },
  );

  it.each(SUMMARIES)('%s says the kill switch closes the tabs an agent controls', (_name, text) => {
    expect(text).toMatch(/kill switch/i);
    expect(text).toMatch(/closes the tabs (an|the) agent controls/i);
  });

  it.each(KILL_SWITCH_STATEMENTS)(
    '%s says an external session is not terminated and a tab can be reopened',
    (_name, text) => {
      expect(text).toMatch(/does not terminate an external/i);
      expect(text).toMatch(/reopen a tab/i);
    },
  );
});
