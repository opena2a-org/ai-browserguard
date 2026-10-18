/**
 * Failed test names from a `vitest run` report, for scripts that run the suite
 * and capture what it prints (`npm run bump`).
 */

// A terminal control sequence (ESC [ ... final byte). Vitest colours its
// report when CI or FORCE_COLOR is set, even when its output is captured.
const CONTROL_SEQUENCE = /\u001b\[[0-?]*[ -/]*[@-~]/g;

// The error summary names each failed test on a line of its own:
// " FAIL  src/a.test.ts > suite > test". A test file that failed to load is
// named as " FAIL  src/a.test.ts [ src/a.test.ts ]".
const FAIL_LINE = /^\s*FAIL\s+(\S+\.(?:test|spec)\.[cm]?[jt]sx?(?=\s|$).*)$/;

/**
 * The tests a `vitest run` report lists as failed.
 *
 * @param {string} output what vitest printed, colour codes included or not
 * @returns {string[]} one `<file> > <suite> > <test>` entry per FAIL line, in
 *   report order; empty when the report names none
 */
export function failedTestNames(output) {
  const names = [];
  for (const line of output.replace(CONTROL_SEQUENCE, '').split(/\r?\n/)) {
    const match = FAIL_LINE.exec(line);
    if (match) names.push(match[1].trim());
  }
  return names;
}
