/**
 * Regression (#143): docs/testing/release-smoke.md said `npm run smoke:export`
 * runs in Playwright's Chromium and that the other smokes in its automated
 * list use the browser Puppeteer installs, though `npm run smoke:playwright`,
 * one of them, launches Playwright's Chromium. Its "Browser each smoke needs"
 * table had no row for `npm run smoke:playwright`, and CONTRIBUTING.md points
 * there for the browser each `npm run smoke:*` script needs.
 *
 * The table, its count of the rows that load the extension with
 * --load-extension, and those sentences are held to package.json and to the
 * smoke scripts: whether each passes --load-extension and reads CHROME_PATH,
 * and the browser library it imports (`playwright` for Playwright's Chromium,
 * `puppeteer` for Chrome for Testing).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';

function read(relPath: string): string {
  return readFileSync(new URL(`../../${relPath}`, import.meta.url), 'utf-8');
}

const DOC = 'docs/testing/release-smoke.md';
const SCRIPTS = JSON.parse(read('package.json')).scripts as Record<string, string>;
const SMOKES = Object.keys(SCRIPTS).filter((name) => name.startsWith('smoke:'));
const COUNT_WORDS = ['no', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve'];

/** The source of the file a smoke:* script runs with `node scripts/<file>.mjs`. */
function smokeSource(smoke: string): string {
  const file = /^node (scripts\/[\w.-]+\.mjs)$/.exec(SCRIPTS[smoke] ?? '')?.[1];
  expect(file, `package.json has no "node scripts/<file>.mjs" script named ${smoke}`).toBeDefined();
  return read(file as string);
}

/** The browser library a smoke script imports: playwright or puppeteer. */
function library(smoke: string): string {
  const imported = new Set(
    [...smokeSource(smoke).matchAll(/^import\s[^;]*?\sfrom\s+'(?:\.\.\/node_modules\/)?(playwright|puppeteer)[/']/gm)]
      .map((match) => match[1]),
  );
  expect([...imported], `${smoke} does not import exactly one of playwright and puppeteer`).toHaveLength(1);
  return [...imported][0];
}

/** A heading's section of the doc, up to the next heading of level 1 to 3. */
function section(heading: string): string {
  const doc = read(DOC);
  const start = doc.indexOf(`\n${heading}\n`);
  expect(start, `${DOC} has no "${heading}" heading`).toBeGreaterThanOrEqual(0);
  const next = /\n#{1,3} /g;
  next.lastIndex = start + heading.length + 1;
  return doc.slice(start, next.exec(doc)?.index);
}

/** Wrapped lines joined into one, so a phrase split across lines still matches. */
function unwrap(text: string): string {
  return text.replace(/\s*\n\s*/g, ' ').trim();
}

function browserTable(): { smoke: string; browser: string }[] {
  const rows = section('### Browser each smoke needs')
    .split('\n')
    .map((line) => /^\| `npm run (smoke:[\w-]+)` \| (.+) \|$/.exec(line))
    .filter((match): match is RegExpExecArray => match !== null)
    .map((match) => ({ smoke: match[1], browser: match[2] }));
  expect(rows.length, 'the "Browser each smoke needs" table has no rows').toBeGreaterThan(0);
  return rows;
}

describe('release-smoke.md: the browser each smoke runs in (#143)', () => {
  it('has one row in the browser table for each smoke:* script in package.json', () => {
    expect(browserTable().map(({ smoke }) => smoke).sort()).toEqual([...SMOKES].sort());
  });

  it('names in each row the browser of the library its script imports', () => {
    for (const { smoke, browser } of browserTable()) {
      const expected = library(smoke) === 'playwright' ? /^Playwright's (?:headless )?Chromium\b/ : /^Chrome for Testing\b/;
      expect(browser, smoke).toMatch(expected);
    }
  });

  it('counts the leading rows whose scripts pass --load-extension and do not read CHROME_PATH', () => {
    const flagged = browserTable().map(({ smoke }) => {
      const source = smokeSource(smoke);
      return source.includes('--load-extension=${') && !source.includes('process.env.CHROME_PATH');
    });
    const first = flagged.includes(false) ? flagged.indexOf(false) : flagged.length;
    expect(flagged.slice(first), 'a row whose script passes --load-extension sits below one whose script does not').not.toContain(true);
    expect(unwrap(section('### Browser each smoke needs'))).toContain(
      `The first ${COUNT_WORDS[first]} load the extension with \`--load-extension\` and do not read \`CHROME_PATH\``,
    );
  });

  it('names, below the automated list, the browser each smoke in the list runs in', () => {
    const automated = section('## Automated portion');
    const block = /^```\n([\s\S]*?)\n```$/m.exec(automated)?.[1];
    expect(block, 'the Automated portion has no command block').toBeDefined();
    const listed = [...(block as string).matchAll(/^npm run (smoke:[\w-]+)/gm)].map((match) => match[1]);
    expect(listed.length).toBeGreaterThan(0);

    const paragraphs = automated
      .split(/\n\s*\n/)
      .map(unwrap)
      .filter((paragraph) => paragraph.includes("Playwright's Chromium") && paragraph.includes('the browser Puppeteer installs'));
    expect(paragraphs, 'no single paragraph of the Automated portion names both browsers').toHaveLength(1);
    const sentences = paragraphs[0].split(/(?<=\.)\s+/);
    const namedWith = (phrase: string): string[] =>
      sentences
        .filter((sentence) => sentence.includes(phrase))
        .flatMap((sentence) => [...sentence.matchAll(/`npm run (smoke:[\w-]+)`/g)].map((match) => match[1]))
        .sort();

    expect(namedWith("Playwright's Chromium")).toEqual(listed.filter((smoke) => library(smoke) === 'playwright').sort());
    expect(namedWith('the browser Puppeteer installs')).toEqual(listed.filter((smoke) => library(smoke) === 'puppeteer').sort());
  });
});
