/**
 * The README in short form.
 *
 * A person deciding whether to install the extension reads the README first,
 * so it states what the extension detects, what it cannot stop and where to
 * install it, and links a page for the rest. These cases hold its paragraphs
 * to the length a reader takes in at a glance, keep the install link and the
 * demo recording above the first section, and check that the sentences the
 * opening paragraph gave up are on the scope of enforcement page it links.
 *
 * A paragraph is a run of non-blank lines outside code fences, headings,
 * table rows and image or HTML lines, each list item counted on its own,
 * with a quote's `>` marks counted among its words. A line holding only `>`
 * is not blank, so it joins the quoted paragraphs on either side of it into
 * one.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';

function read(relPath: string): string {
  return readFileSync(new URL(`../../${relPath}`, import.meta.url), 'utf-8');
}

const readme = read('README.md');
const lines = readme.split('\n');

interface Paragraph {
  line: number;
  words: number;
}

function paragraphs(text: string): Paragraph[] {
  const found: Paragraph[] = [];
  let current: string[] = [];
  let start = 0;
  let fence = '';
  const flush = () => {
    if (current.length > 0) {
      found.push({ line: start, words: current.join(' ').split(/\s+/).filter(Boolean).length });
    }
    current = [];
  };
  text.split('\n').forEach((raw, index) => {
    const marker = /^\s*(`{3,}|~{3,})/.exec(raw);
    if (marker) {
      if (!fence) {
        flush();
        fence = marker[1][0];
      } else if (marker[1][0] === fence) {
        fence = '';
      }
      return;
    }
    if (fence) return;
    const line = raw.trim();
    if (!line || /^(#{1,6}\s|\||<|!\[|\[!\[|-{3,}$|={3,}$)/.test(line)) {
      flush();
      return;
    }
    if (/^([-*+]|\d+\.)\s/.test(line)) flush();
    if (current.length === 0) start = index + 1;
    current.push(line);
  });
  flush();
  return found;
}

/** The 1-based number of the first line matching `pattern`, or 0. */
function firstLine(pattern: RegExp): number {
  return lines.findIndex((line) => pattern.test(line)) + 1;
}

describe('README paragraphs', () => {
  const found = paragraphs(readme);

  it('has no paragraph longer than 69 words', () => {
    const long = found.filter((p) => p.words > 69).map((p) => `line ${p.line}: ${p.words} words`);
    expect(long).toEqual([]);
  });

  it('has at most one paragraph over 60 words', () => {
    expect(found.filter((p) => p.words > 60).length).toBeLessThanOrEqual(1);
  });

  it('counts a line holding only ">" as part of the quoted paragraph around it', () => {
    expect(paragraphs('> one two\n>\n> three four five')).toEqual([{ line: 1, words: 8 }]);
    expect(paragraphs('> one two\n\n> three four five')).toEqual([
      { line: 1, words: 3 },
      { line: 3, words: 4 },
    ]);
  });
});

describe('README first screen', () => {
  const firstSection = firstLine(/^## /);

  it('puts the Chrome Web Store link in the first 30 lines, above the first section', () => {
    const store = firstLine(/chromewebstore\.google\.com/);
    expect(store).toBeGreaterThan(0);
    expect(store).toBeLessThanOrEqual(30);
    expect(store).toBeLessThan(firstSection);
  });

  it('puts the demo recording in the first 30 lines, above the first section', () => {
    const recording = firstLine(/^!\[[^\]]+\]\(docs\/browserguard-demo\.gif\)$/);
    expect(recording).toBeGreaterThan(0);
    expect(recording).toBeLessThanOrEqual(30);
    expect(recording).toBeLessThan(firstSection);
    expect(() => read('docs/browserguard-demo.gif')).not.toThrow();
  });
});

describe('README opening paragraph', () => {
  const opening = lines.find((line) => line.startsWith('Chrome extension that detects'));

  it('states what the extension cannot block and links the scope of enforcement page', () => {
    expect(opening).toBeDefined();
    expect(opening).toMatch(/\*\*cannot\*\* block/);
    expect(opening).toMatch(/over CDP/);
    expect(opening).toContain('](docs/enforcement-scope.md)');
  });

  it('left its in-page blocking and download sentences on the scope of enforcement page', () => {
    const page = read('docs/enforcement-scope.md');
    expect(page).toContain(
      'For in-page and injected automation it can also block scripted navigations, form submissions, and new-tab opens (best-effort, in the page realm).',
    );
    expect(page).toContain(
      "Under a delegation that does not permit downloads, it can cancel a download that Chrome reports starting in an agent's tab, for every kind of agent, including one you start there.",
    );
    expect(page).toContain(
      'Beyond that it **cannot** block external automation frameworks that drive the browser over CDP; against those, AI Browser Guard provides detection, alerting, and a kill switch that closes the tab, not per-action enforcement.',
    );
  });
});
