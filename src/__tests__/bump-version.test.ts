/**
 * `npm run bump` fails when vitest exits non-zero (#140).
 *
 * scripts/bump-version.js read the passed count with `Tests\s+(\d+)\s+passed`
 * in the branch that handles a non-zero exit as well, and a match there
 * skipped the failure branch. A test file that fails to load, in a run whose
 * other tests pass, makes vitest 2.1.9 exit 1 while its summary counts only
 * passed tests (`Tests  9 passed (9)` in the first report below). In a report
 * without colour codes that line matched, so the bump kept the new version
 * and built.
 *
 * Each case runs a copy of the script on copies of manifest.json, package.json
 * and STATUS.md, with `npx` and `npm` on PATH replaced by shell scripts: `npx`
 * prints a report and exits with the status vitest exited with, and `npm`
 * prints the command it was given. The reports are lines vitest 2.1.9 printed
 * without colour. The stand-ins are POSIX shell scripts, so the cases are
 * skipped on Windows.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'child_process';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { delimiter, join } from 'path';
import { fileURLToPath } from 'url';

const REPO = fileURLToPath(new URL('../../', import.meta.url));
const RELEASE_FILES = ['manifest.json', 'package.json', 'STATUS.md'];

// A test file that fails to load, in a run whose collected tests pass.
const LOAD_FAILURE_REPORT = [
  ' ✓ src/__tests__/vitest-failures.test.ts (5 tests) 2ms',
  ' ❯ src/__tests__/zz-load-failure.test.ts (0 test)',
  ' ✓ src/__tests__/release-metadata.test.ts (4 tests) 1ms',
  '',
  '⎯⎯⎯⎯⎯⎯ Failed Suites 1 ⎯⎯⎯⎯⎯⎯⎯',
  '',
  ' FAIL  src/__tests__/zz-load-failure.test.ts [ src/__tests__/zz-load-failure.test.ts ]',
  'Error: fails to load',
  ' ❯ src/__tests__/zz-load-failure.test.ts:1:36',
  '',
  ' Test Files  1 failed | 2 passed (3)',
  '      Tests  9 passed (9)',
].join('\n');

// A failed test: the bump run before the changelog heading was renamed.
const FAILED_TEST =
  'src/__tests__/release-metadata.test.ts > release metadata is consistent > manifest, package, and changelog declare the same version';
const FAILED_TEST_REPORT = [
  ' ✓ src/__tests__/vitest-failures.test.ts (5 tests) 2ms',
  ' ❯ src/__tests__/release-metadata.test.ts (4 tests | 1 failed) 4ms',
  '   × release metadata is consistent > manifest, package, and changelog declare the same version 3ms',
  "     → expected '0.7.0' to be '0.7.1' // Object.is equality",
  '',
  '⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯',
  '',
  ` FAIL  ${FAILED_TEST}`,
  "AssertionError: expected '0.7.0' to be '0.7.1' // Object.is equality",
  '',
  ' Test Files  1 failed | 1 passed (2)',
  '      Tests  1 failed | 8 passed (9)',
].join('\n');

const PASSING_REPORT = [
  ' ✓ src/__tests__/release-metadata.test.ts (4 tests) 1ms',
  ' ✓ src/__tests__/vitest-failures.test.ts (5 tests) 2ms',
  '',
  ' Test Files  2 passed (2)',
  '      Tests  9 passed (9)',
].join('\n');

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function readRepo(file: string): string {
  return readFileSync(join(REPO, file), 'utf-8');
}

/** Write the shell script `name` into `bin`, executable. */
function shellScript(bin: string, name: string, body: string): void {
  const path = join(bin, name);
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
}

/**
 * Run `bump-version.js patch` in a temporary directory, with vitest replaced
 * by a script that prints `report` and exits with `status`.
 */
function bump(report: string, status: number) {
  const dir = mkdtempSync(join(tmpdir(), 'bump-version-'));
  dirs.push(dir);
  mkdirSync(join(dir, 'scripts'));
  for (const script of ['bump-version.js', 'vitest-failures.mjs']) {
    copyFileSync(join(REPO, 'scripts', script), join(dir, 'scripts', script));
  }
  for (const file of RELEASE_FILES) copyFileSync(join(REPO, file), join(dir, file));
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'vitest-report.txt'), `${report}\n`);
  shellScript(bin, 'npx', `cat "$(dirname "$0")/vitest-report.txt"\nexit ${status}`);
  shellScript(bin, 'npm', 'echo "npm $*"');
  const run = spawnSync(process.execPath, [join(dir, 'scripts', 'bump-version.js'), 'patch'], {
    cwd: dir,
    encoding: 'utf-8',
    env: { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH ?? ''}` },
  });
  const read = (file: string) => readFileSync(join(dir, file), 'utf-8');
  return { status: run.status, stdout: run.stdout, stderr: run.stderr, read };
}

describe.skipIf(process.platform === 'win32')('npm run bump', () => {
  const current = (JSON.parse(readRepo('manifest.json')) as { version: string }).version;
  const [major, minor, patch] = current.split('.').map(Number);
  const next = `${major}.${minor}.${patch + 1}`;

  it('keeps the new version and builds when vitest exits 0', () => {
    const run = bump(PASSING_REPORT, 0);
    expect(run.status).toBe(0);
    expect(run.stdout).toContain(`Version: ${current} -> ${next}`);
    expect(run.stdout).toContain('Tests: 9 passing');
    expect(run.stdout).toContain('npm run build');
    expect((JSON.parse(run.read('manifest.json')) as { version: string }).version).toBe(next);
    expect((JSON.parse(run.read('package.json')) as { version: string }).version).toBe(next);
    expect(run.read('STATUS.md')).toContain(`currently at v${next}`);
  });

  it('puts the three files back and does not build when a test file fails to load (#140)', () => {
    const run = bump(LOAD_FAILURE_REPORT, 1);
    expect(run.status).toBe(1);
    expect(run.stderr).toContain(
      '  src/__tests__/zz-load-failure.test.ts [ src/__tests__/zz-load-failure.test.ts ]',
    );
    expect(run.stderr).toContain(`Reverted manifest.json, package.json and STATUS.md to ${current}.`);
    expect(run.stdout).not.toContain('Tests: 9 passing');
    expect(run.stdout).not.toContain('npm run build');
    for (const file of RELEASE_FILES) expect(run.read(file)).toBe(readRepo(file));
  });

  it('puts the three files back and names the test when a test fails', () => {
    const run = bump(FAILED_TEST_REPORT, 1);
    expect(run.status).toBe(1);
    expect(run.stderr).toContain(`Failed tests (1):\n  ${FAILED_TEST}\n`);
    expect(run.stdout).not.toContain('npm run build');
    for (const file of RELEASE_FILES) expect(run.read(file)).toBe(readRepo(file));
  });
});
