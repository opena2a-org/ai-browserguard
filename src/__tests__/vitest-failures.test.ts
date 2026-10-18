/**
 * Failed test names for `npm run bump` (#134).
 *
 * The bump runs the test suite and puts the version back when it fails. It
 * printed "Tests failed. Fix tests before bumping." and named no test, so a
 * bump run before the changelog heading was renamed gave no hint that the
 * release metadata test was the one failing. scripts/bump-version.js now
 * prints the names scripts/vitest-failures.mjs reads from the captured report.
 * The reports below are lines vitest 2.1.9 printed.
 */
import { describe, it, expect } from 'vitest';
import { failedTestNames } from '../../scripts/vitest-failures.mjs';

const CHANGELOG_TEST =
  'src/__tests__/release-metadata.test.ts > release metadata is consistent > manifest, package, and changelog declare the same version';
const STATUS_TEST =
  'src/__tests__/release-metadata.test.ts > release metadata is consistent > STATUS.md states the current version';

// The release metadata test after a version change, without colour.
const PLAIN_REPORT = [
  ' ❯ src/__tests__/release-metadata.test.ts (3 tests | 2 failed) 4ms',
  '   × release metadata is consistent > manifest, package, and changelog declare the same version 3ms',
  "     → expected '0.7.0' to be '0.8.0' // Object.is equality",
  '   × release metadata is consistent > STATUS.md states the current version 0ms',
  "     → expected '0.7.0' to be '0.8.0' // Object.is equality",
  '',
  '⎯⎯⎯⎯⎯⎯⎯ Failed Tests 2 ⎯⎯⎯⎯⎯⎯⎯',
  '',
  ` FAIL  ${CHANGELOG_TEST}`,
  "AssertionError: expected '0.7.0' to be '0.8.0' // Object.is equality",
  '',
  ` FAIL  ${STATUS_TEST}`,
  "AssertionError: expected '0.7.0' to be '0.8.0' // Object.is equality",
  '',
  ' Test Files  1 failed (1)',
  '      Tests  2 failed | 1 passed (3)',
].join('\n');

// The same test with FORCE_COLOR set, in a run with a test file that failed
// to load: the error summary and the totals.
const COLOURED_REPORT = [
  '\u001b[31m⎯⎯⎯⎯⎯⎯\u001b[1m\u001b[7m Failed Suites 1 \u001b[27m\u001b[22m⎯⎯⎯⎯⎯⎯⎯\u001b[39m',
  '\u001b[31m\u001b[1m\u001b[7m FAIL \u001b[27m\u001b[22m\u001b[39m src/__tests__/load-failure.test.ts\u001b[2m [ src/__tests__/load-failure.test.ts ]\u001b[22m',
  '\u001b[31m\u001b[1mError\u001b[22m: scratch file that fails to load\u001b[39m',
  '\u001b[31m⎯⎯⎯⎯⎯⎯⎯\u001b[1m\u001b[7m Failed Tests 2 \u001b[27m\u001b[22m⎯⎯⎯⎯⎯⎯⎯\u001b[39m',
  '\u001b[31m\u001b[1m\u001b[7m FAIL \u001b[27m\u001b[22m\u001b[39m src/__tests__/release-metadata.test.ts\u001b[2m > \u001b[22mrelease metadata is consistent\u001b[2m > \u001b[22mmanifest, package, and changelog declare the same version',
  "\u001b[31m\u001b[1mAssertionError\u001b[22m: expected '0.7.0' to be '0.8.0' // Object.is equality\u001b[39m",
  '\u001b[31m\u001b[1m\u001b[7m FAIL \u001b[27m\u001b[22m\u001b[39m src/__tests__/release-metadata.test.ts\u001b[2m > \u001b[22mrelease metadata is consistent\u001b[2m > \u001b[22mSTATUS.md states the current version',
  "\u001b[31m\u001b[1mAssertionError\u001b[22m: expected '0.7.0' to be '0.8.0' // Object.is equality\u001b[39m",
  '\u001b[2m Test Files \u001b[22m \u001b[1m\u001b[31m2 failed\u001b[39m\u001b[22m\u001b[90m (2)\u001b[39m',
  '\u001b[2m      Tests \u001b[22m \u001b[1m\u001b[31m2 failed\u001b[39m\u001b[22m\u001b[2m | \u001b[22m\u001b[1m\u001b[32m1 passed\u001b[39m\u001b[22m\u001b[90m (3)\u001b[39m',
].join('\n');

describe('failedTestNames', () => {
  it('names each failed test in an uncoloured report, in report order', () => {
    expect(failedTestNames(PLAIN_REPORT)).toEqual([CHANGELOG_TEST, STATUS_TEST]);
  });

  it('names the same tests in a coloured report, and a test file that failed to load', () => {
    expect(failedTestNames(COLOURED_REPORT)).toEqual([
      'src/__tests__/load-failure.test.ts [ src/__tests__/load-failure.test.ts ]',
      CHANGELOG_TEST,
      STATUS_TEST,
    ]);
  });

  it('reads Windows line endings', () => {
    expect(failedTestNames(PLAIN_REPORT.replace(/\n/g, '\r\n'))).toEqual([CHANGELOG_TEST, STATUS_TEST]);
  });

  it('names nothing for a passing report', () => {
    const passing = [
      ' ✓ src/session/storage.test.ts (37 tests) 6ms',
      '',
      ' Test Files  2 passed (2)',
      '      Tests  40 passed (40)',
    ].join('\n');
    expect(failedTestNames(passing)).toEqual([]);
  });

  it('ignores a FAIL line that names no test file, as a smoke check prints', () => {
    expect(failedTestNames('  FAIL  Export JSON button reachable in action popup')).toEqual([]);
  });
});
