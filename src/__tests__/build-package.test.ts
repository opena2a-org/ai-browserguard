/**
 * npm run build packs dist.zip the same way every time, and stops when it
 * cannot pack it.
 *
 * Each case runs scripts/build.js in a copy of the repository under the
 * system temp directory, never in the checkout, so dist/, dist.zip and
 * dist-archive/ in the checkout are left alone. The content digest is
 * computed here from its definition (the sha256 of one `<sha256>  <path>`
 * line per file of dist/, sorted bytewise by path, each ending in a
 * newline), not with the script under test, and dist.zip is read back by
 * src/__tests__/zip-reader.ts, which inflates deflated entries too.
 *
 * The packing cases replace the bundler with a stand-in: `npx` on PATH is a
 * shell script that writes fixed files into dist/ for the entry point the
 * build names, and sets their times. A case controls what dist/ holds and
 * when its files were written. The last case runs the real bundler, in two
 * copies at different paths. All cases need a POSIX shell, so they are
 * skipped on Windows.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'child_process';
import { createHash } from 'crypto';
import {
  chmodSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync,
  symlinkSync, writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import { delimiter, join } from 'path';
import { fileURLToPath } from 'url';
import { readZip } from './zip-reader';

const REPO = fileURLToPath(new URL('../../', import.meta.url));
const POSIX = process.platform !== 'win32';
const RUNS_AS_ROOT = typeof process.getuid === 'function' && process.getuid() === 0;
const HAS_GIT = POSIX && spawnSync('sh', ['-c', 'command -v git'], { stdio: 'ignore' }).status === 0;

// What scripts/build.js reads besides the bundler's output.
const PACKING_FILES = ['scripts', 'manifest.json', 'package.json', 'icons', 'fonts'];
// What the real bundler reads as well.
const BUILD_FILES = [...PACKING_FILES, 'src', 'vite.config.ts', 'tsconfig.json'];

// 2026-10-25T06:55:11Z, written as DOS time 06:55:10 on 2026-10-25.
const SOURCE_DATE_EPOCH = '1792911311';
const DOS_TIME = (6 << 11) | (55 << 5) | 5;
const DOS_DATE = ((2026 - 1980) << 9) | (10 << 5) | 25;

const STANDIN_NPX = `#!/bin/sh
# Stand-in for the bundler: writes fixed files for the entry point named by
# ENTRY into dist/, then sets every file's time to STANDIN_TOUCH.
set -e
case "$ENTRY" in
  content) mkdir -p dist/content && printf 'content script\\n' > dist/content/index.js ;;
  interceptor) mkdir -p dist/content && printf 'interceptor\\n' > dist/content/interceptor.js ;;
  background) mkdir -p dist/background && printf 'service worker\\n' > dist/background/index.js ;;
  popup)
    mkdir -p dist/popup
    printf '<!doctype html><title>__VERSION__</title>\\n' > dist/popup/index.html
    printf 'popup\\n' > dist/popup/popup.js
    case "$STANDIN_EXTRA" in
      unreadable) printf 'locked\\n' > dist/popup/locked.js && chmod 000 dist/popup/locked.js ;;
      symlink) ln -s ../../outside.txt dist/popup/linked.js ;;
    esac
    ;;
esac
find dist -type f -exec touch -t "$STANDIN_TOUCH" {} +
`;

const sha256 = (data: Uint8Array | string) => createHash('sha256').update(data).digest('hex');
const byteOrder = (a: string, b: string) => Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));

function digestOf(files: Map<string, Buffer>): string {
  const paths = [...files.keys()].sort(byteOrder);
  return sha256(paths.map((path) => `${sha256(files.get(path)!)}  ${path}\n`).join(''));
}

// The UTC time that MS-DOS time and date fields hold, as an ISO string.
function dosTimeIso(time: number, date: number): string {
  return new Date(Date.UTC(
    1980 + (date >> 9), ((date >> 5) & 0x0f) - 1, date & 0x1f,
    time >> 11, (time >> 5) & 0x3f, (time & 0x1f) * 2,
  )).toISOString();
}

// The distinct times the entries of an archive carry, in their central and
// local headers alike.
function carriedTimes(zip: Buffer): string[] {
  return [...new Set(readZip(zip).entries.flatMap(({ time, date, local }) => [
    dosTimeIso(time, date), dosTimeIso(local.time, local.date),
  ]))];
}

// The time on the build's `entry time` line, and what follows it in parentheses.
function printedEntryTime(stdout: string): [string, string] | null {
  const match = /^ {2}entry time +(\S+) \((.*)\)$/m.exec(stdout);
  return match ? [match[1], match[2]] : null;
}

function filesUnder(dir: string, prefix = '', found = new Map<string, Buffer>()): Map<string, Buffer> {
  for (const name of readdirSync(dir)) {
    const file = join(dir, name);
    const path = prefix ? `${prefix}/${name}` : name;
    if (lstatSync(file).isDirectory()) filesUnder(file, path, found);
    else found.set(path, readFileSync(file));
  }
  return found;
}

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    spawnSync('chmod', ['-R', 'u+rwx', dir]);
    rmSync(dir, { recursive: true, force: true });
  }
});

function copyOfRepository(files: string[], depth: string[] = []): string {
  const base = mkdtempSync(join(tmpdir(), 'abg-build-'));
  dirs.push(base);
  const root = join(base, ...depth, 'repo');
  mkdirSync(root, { recursive: true });
  for (const file of files) cpSync(join(REPO, file), join(root, file), { recursive: true });
  return root;
}

function standInPath(root: string): string {
  const bin = join(root, '..', 'stand-in-bin');
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, 'npx'), STANDIN_NPX);
  chmodSync(join(bin, 'npx'), 0o755);
  return `${bin}${delimiter}${process.env.PATH ?? ''}`;
}

function runBuild(root: string, env: Record<string, string>) {
  const result = spawnSync(process.execPath, ['scripts/build.js'], {
    cwd: root,
    env: { ...process.env, SOURCE_DATE_EPOCH, ...env },
    encoding: 'utf8',
  });
  return { ...result, output: `${result.stdout}${result.stderr}` };
}

function packingCopy(): { root: string; PATH: string } {
  const root = copyOfRepository(PACKING_FILES);
  return { root, PATH: standInPath(root) };
}

describe.skipIf(!POSIX)('npm run build packs dist.zip', () => {
  it('gives the same dist.zip for the same files when their times on disk differ', () => {
    const { root, PATH } = packingCopy();

    const first = runBuild(root, { PATH, STANDIN_TOUCH: '200101010000' });
    expect(first.status, first.output).toBe(0);
    const firstZip = sha256(readFileSync(join(root, 'dist.zip')));
    const firstDigest = digestOf(filesUnder(join(root, 'dist')));

    const second = runBuild(root, { PATH, STANDIN_TOUCH: '200202020202' });
    expect(second.status, second.output).toBe(0);
    expect(digestOf(filesUnder(join(root, 'dist')))).toBe(firstDigest);
    expect(sha256(readFileSync(join(root, 'dist.zip'))), 'dist.zip changed between two builds of the same files').toBe(firstZip);
  });

  it('holds exactly the files of dist/, each carrying the source date', () => {
    const { root, PATH } = packingCopy();
    const build = runBuild(root, { PATH, STANDIN_TOUCH: '200101010000' });
    expect(build.status, build.output).toBe(0);

    const { entries } = readZip(readFileSync(join(root, 'dist.zip')));
    const files = filesUnder(join(root, 'dist'));
    expect(entries.map(({ name }) => name), 'the entries are the files of dist/ in bytewise order, with no directory entries')
      .toEqual([...files.keys()].sort(byteOrder));
    expect(digestOf(new Map(entries.map(({ name, data }) => [name, data])))).toBe(digestOf(files));
    expect(entries.filter(({ time, date }) => time !== DOS_TIME || date !== DOS_DATE).map(({ name }) => name), 'entries not carrying the source date')
      .toEqual([]);
  });

  it('prints the entry time the entries of dist.zip carry, and the source date when the two differ', () => {
    const cases = [
      // An odd second: a zip entry holds its time at two-second precision.
      { epoch: '1792911311', carried: '2026-10-25T06:55:10.000Z', note: 'SOURCE_DATE_EPOCH, 2026-10-25T06:55:11.000Z, rounded down to the two-second precision of a zip entry' },
      { epoch: '1792911310', carried: '2026-10-25T06:55:10.000Z', note: 'SOURCE_DATE_EPOCH' },
      // Before 1980 and after 2107: outside the range a zip entry can hold.
      { epoch: '0', carried: '1980-01-01T00:00:00.000Z', note: 'SOURCE_DATE_EPOCH, 1970-01-01T00:00:00.000Z, clamped to the earliest time a zip entry can carry' },
      { epoch: '7258118400', carried: '2107-12-31T23:59:58.000Z', note: 'SOURCE_DATE_EPOCH, 2200-01-01T00:00:00.000Z, clamped to the latest time a zip entry can carry' },
      // The copy is not a git checkout, so with no SOURCE_DATE_EPOCH there is no commit time.
      { epoch: '', carried: '1980-01-01T00:00:00.000Z', note: 'no commit found: the earliest time a zip entry can carry' },
    ];
    for (const { epoch, carried, note } of cases) {
      const { root, PATH } = packingCopy();
      const build = runBuild(root, { PATH, STANDIN_TOUCH: '200101010000', SOURCE_DATE_EPOCH: epoch });
      expect(build.status, build.output).toBe(0);
      expect(carriedTimes(readFileSync(join(root, 'dist.zip'))), `SOURCE_DATE_EPOCH=${epoch}: the times the entries carry`)
        .toEqual([carried]);
      expect(printedEntryTime(build.stdout), `SOURCE_DATE_EPOCH=${epoch}: the entry time line of\n${build.stdout}`)
        .toEqual([carried, note]);
    }
  });

  it.skipIf(!HAS_GIT)('takes the entry time from the commit time of HEAD when SOURCE_DATE_EPOCH is not set', () => {
    const { root, PATH } = packingCopy();
    const env = {
      ...process.env,
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_AUTHOR_DATE: `@${SOURCE_DATE_EPOCH} +0000`,
      GIT_COMMITTER_DATE: `@${SOURCE_DATE_EPOCH} +0000`,
    };
    for (const args of [['init', '-q'], ['add', '.'], ['commit', '-q', '--no-verify', '-m', 'build input']]) {
      const git = spawnSync('git', ['-c', 'user.name=Build test', '-c', 'user.email=build-test@example.invalid', '-c', 'commit.gpgsign=false', ...args], { cwd: root, env, encoding: 'utf8' });
      expect(git.status, git.stderr).toBe(0);
    }

    const build = runBuild(root, { PATH, STANDIN_TOUCH: '200101010000', SOURCE_DATE_EPOCH: '' });
    expect(build.status, build.output).toBe(0);
    expect(build.stdout).toContain('the commit time of HEAD');
    const times = readZip(readFileSync(join(root, 'dist.zip'))).entries.map(({ time, date }) => [time, date]);
    expect(times.length).toBeGreaterThan(0);
    expect(times.filter(([time, date]) => time !== DOS_TIME || date !== DOS_DATE), 'entries not carrying the commit time').toEqual([]);
    // The commit time is an odd second; the entries carry the second before it.
    expect(printedEntryTime(build.stdout), build.stdout).toEqual([
      dosTimeIso(DOS_TIME, DOS_DATE),
      'the commit time of HEAD, 2026-10-25T06:55:11.000Z, rounded down to the two-second precision of a zip entry',
    ]);
  });

  it.skipIf(RUNS_AS_ROOT)('exits non-zero, with no dist.zip, when a file of dist/ cannot be read', () => {
    const { root, PATH } = packingCopy();
    const build = runBuild(root, { PATH, STANDIN_TOUCH: '200101010000', STANDIN_EXTRA: 'unreadable' });
    expect(build.status, `the build exited ${build.status} although dist.zip could not be packed:\n${build.output}`).not.toBe(0);
    expect(build.stderr).toContain('Could not package dist.zip');
    expect(existsSync(join(root, 'dist.zip')), 'a dist.zip was left behind').toBe(false);
  });

  it('exits non-zero, with no dist.zip, when dist/ holds a symbolic link to a file outside it', () => {
    const { root, PATH } = packingCopy();
    writeFileSync(join(root, 'outside.txt'), 'a file outside dist/\n');
    const build = runBuild(root, { PATH, STANDIN_TOUCH: '200101010000', STANDIN_EXTRA: 'symlink' });
    const zipPath = join(root, 'dist.zip');
    const packed = existsSync(zipPath) ? readZip(readFileSync(zipPath)).entries.map(({ name }) => name) : [];
    expect(packed, 'a dist.zip was written, holding these entries').toEqual([]);
    expect(build.status, `the build exited ${build.status} with a link to a file outside dist/ under dist/:\n${build.output}`).not.toBe(0);
    expect(build.stderr).toContain('popup/linked.js is a symbolic link');
  });

  it('builds twice, in two copies at different paths, with the same content digest and the same dist.zip', () => {
    // One build after the other, as two release runs would be.
    const roots = [copyOfRepository(BUILD_FILES), copyOfRepository(BUILD_FILES, ['a', 'deeper', 'path'])];
    for (const root of roots) {
      symlinkSync(join(REPO, 'node_modules'), join(root, 'node_modules'), 'dir');
      const build = runBuild(root, { npm_config_offline: 'true', npm_config_update_notifier: 'false' });
      expect(build.status, build.output).toBe(0);
    }

    const [first, second] = roots.map((root) => {
      const zip = readFileSync(join(root, 'dist.zip'));
      return {
        digest: digestOf(filesUnder(join(root, 'dist'))),
        zipSha256: sha256(zip),
        zipDigest: digestOf(new Map(readZip(zip).entries.filter(({ name }) => !name.endsWith('/')).map(({ name, data }) => [name, data]))),
      };
    });
    expect(second.digest, 'the content digest of dist/ differs between the two builds').toBe(first.digest);
    expect(first.zipDigest, 'dist.zip does not hold the files of dist/').toBe(first.digest);
    expect(second.zipSha256, 'dist.zip differs between the two builds').toBe(first.zipSha256);
  }, 300_000);
});
