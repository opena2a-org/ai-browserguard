/**
 * The README and CONTRIBUTING.md state no test count.
 *
 * The development commands' `npm run test` line carried a count of tests
 * that went stale whenever tests were added, and was corrected by hand
 * several times. The line now says what the command does, and this test
 * keeps a count from being written back into the README or into
 * CONTRIBUTING.md, where the development commands now live.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';

const read = (file: string) => readFileSync(new URL(`../../${file}`, import.meta.url), 'utf-8');

const README = read('README.md');
const CONTRIBUTING = read('CONTRIBUTING.md');

// "1397 tests", "1,486 tests", or a shields.io badge such as "tests-1397%20passing".
const TEST_COUNT = [/\b\d[\d,]*\s+tests?\b/i, /\btests-\d/i];

function linesStatingATestCount(text: string) {
  return text.split('\n')
    .map((line, i) => ({ line: i + 1, text: line }))
    .filter(({ text: line }) => TEST_COUNT.some((pattern) => pattern.test(line)));
}

describe('documented test count', () => {
  it('the README does not state a number of tests', () => {
    expect(linesStatingATestCount(README)).toEqual([]);
  });

  it('CONTRIBUTING.md does not state a number of tests', () => {
    expect(linesStatingATestCount(CONTRIBUTING)).toEqual([]);
  });

  it('CONTRIBUTING.md still documents the test command', () => {
    expect(CONTRIBUTING).toMatch(/^npm run test\b/m);
  });
});
