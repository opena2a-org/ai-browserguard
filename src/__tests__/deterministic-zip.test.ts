/**
 * scripts/deterministic-zip.mjs writes dist.zip so that the same files at
 * the same commit give the same bytes on every machine: entries in bytewise
 * path order, stored, every one carrying the source date in UTC, with no
 * extra fields and one fixed file mode.
 *
 * The archives are read back by src/__tests__/zip-reader.ts, which walks
 * the end record, the central directory and the local headers and returns
 * their fields as the zip specification lays them out. CRC values are
 * checked against a bitwise CRC-32 written here, not the table the script
 * uses. Each case writes its own directory under the system temp directory.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'child_process';
import { createHash } from 'crypto';
import {
  chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync,
  utimesSync, writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import {
  EARLIEST_ZIP_DATE, LATEST_ZIP_DATE, crc32, dosDateTime, packDirectory, sourceDate, zipEntryDate, zipFiles,
} from '../../scripts/deterministic-zip.mjs';
import { readZip } from './zip-reader';

const MODULE = fileURLToPath(new URL('../../scripts/deterministic-zip.mjs', import.meta.url));
const POSIX = process.platform !== 'win32';
const has = (tool: string) => POSIX && spawnSync('sh', ['-c', `command -v ${tool}`], { stdio: 'ignore' }).status === 0;
const HAS_GIT = has('git');
const HAS_UNZIP = has('unzip');

// 2026-10-25T06:55:11Z: DOS time 06:55:10 (two-second precision), date 2026-10-25.
const SOURCE_DATE = new Date(Date.UTC(2026, 9, 25, 6, 55, 11));
const DOS_TIME = (6 << 11) | (55 << 5) | 5;
const DOS_DATE = ((2026 - 1980) << 9) | (10 << 5) | 25;

const FILES: Record<string, string> = {
  'manifest.json': '{"manifest_version":3}\n',
  'background/index.js': 'self.addEventListener("install", () => {});\n',
  'popup/index.html': '<!doctype html>\n',
  'popup/popup.js': 'console.log("popup");\n',
  'icons/icon16.png': '\u0089PNG fake image bytes\n',
};

const sha256 = (data: Uint8Array) => createHash('sha256').update(data).digest('hex');
const byteOrder = (a: string, b: string) => Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));

function bitwiseCrc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

// The UTC time that MS-DOS time and date fields hold, as an ISO string.
function dosTimeIso(time: number, date: number): string {
  return new Date(Date.UTC(
    1980 + (date >> 9), ((date >> 5) & 0x0f) - 1, date & 0x1f,
    time >> 11, (time >> 5) & 0x3f, (time & 0x1f) * 2,
  )).toISOString();
}

// Source dates, and the time a zip entry written for each one carries.
const ENTRY_DATES: [Date, string][] = [
  [SOURCE_DATE, '2026-10-25T06:55:10.000Z'], // an odd second
  [new Date(Date.UTC(2026, 9, 25, 6, 55, 10)), '2026-10-25T06:55:10.000Z'],
  [new Date(Date.UTC(2026, 9, 25, 6, 55, 10, 999)), '2026-10-25T06:55:10.000Z'],
  [new Date(0), '1980-01-01T00:00:00.000Z'],
  [new Date(Date.UTC(1979, 11, 31, 23, 59, 59)), '1980-01-01T00:00:00.000Z'],
  [new Date(Date.UTC(1980, 0, 1, 0, 0, 1)), '1980-01-01T00:00:00.000Z'],
  [new Date(Date.UTC(2107, 11, 31, 23, 59, 59)), '2107-12-31T23:59:58.000Z'],
  [new Date(Date.UTC(2200, 0, 1)), '2107-12-31T23:59:58.000Z'],
];

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    if (POSIX) spawnSync('chmod', ['-R', 'u+rwx', dir]);
    rmSync(dir, { recursive: true, force: true });
  }
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'abg-zip-'));
  dirs.push(dir);
  return dir;
}

function writeTree(files: Record<string, string>, order: string[] = Object.keys(files)): string {
  const dir = tempDir();
  for (const path of order) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), files[path]);
  }
  return dir;
}

function pack(dir: string, date = SOURCE_DATE): Buffer {
  const out = join(tempDir(), 'dist.zip');
  const result = packDirectory(dir, out, date);
  const bytes = readFileSync(out);
  expect(result.bytes).toBe(bytes.length);
  expect(result.sha256).toBe(sha256(bytes));
  return bytes;
}

describe('deterministic dist.zip', () => {
  it('computes CRC-32 to the standard check value', () => {
    expect(crc32(Buffer.from('123456789'))).toBe(0xcbf43926);
    expect(crc32(Buffer.alloc(0))).toBe(0);
    const sample = Buffer.from(FILES['background/index.js']);
    expect(crc32(sample)).toBe(bitwiseCrc32(sample));
  });

  it('gives the same bytes for the same files, whatever their order, times or modes on disk', () => {
    const first = writeTree(FILES);
    const second = writeTree(FILES, Object.keys(FILES).reverse());
    for (const [index, path] of Object.keys(FILES).entries()) {
      utimesSync(join(second, path), 86_400 * (index + 1), 86_400 * (index + 9));
      if (POSIX) chmodSync(join(second, path), index % 2 ? 0o600 : 0o755);
    }
    expect(sha256(pack(second))).toBe(sha256(pack(first)));
  });

  it('holds the regular files in bytewise path order, stored, with no directory entries', () => {
    const bytes = pack(writeTree(FILES));
    const { entries, commentLength, endsAt } = readZip(bytes);
    expect(entries.map(({ name }) => name)).toEqual(Object.keys(FILES).sort(byteOrder));
    for (const entry of entries) {
      const expected = Buffer.from(FILES[entry.name]);
      expect(entry.method).toBe(0);
      expect(entry.local.method).toBe(0);
      expect(entry.size).toBe(expected.length);
      expect(entry.compressedSize).toBe(expected.length);
      expect(entry.data.equals(expected)).toBe(true);
      expect(entry.crc).toBe(bitwiseCrc32(expected));
      expect(entry.local.crc).toBe(entry.crc);
    }
    expect(commentLength).toBe(0);
    expect(endsAt).toBe(bytes.length);
  });

  it('gives every entry the source date in UTC, at two-second precision', () => {
    expect(dosDateTime(SOURCE_DATE)).toEqual({ time: DOS_TIME, date: DOS_DATE });
    for (const entry of readZip(pack(writeTree(FILES))).entries) {
      expect([entry.time, entry.date, entry.local.time, entry.local.date]).toEqual([DOS_TIME, DOS_DATE, DOS_TIME, DOS_DATE]);
    }
  });

  it.skipIf(!POSIX)('writes the same bytes in any time zone', () => {
    const script = [
      `import { zipFiles } from ${JSON.stringify(pathToFileURL(MODULE).href)};`,
      "import { createHash } from 'crypto';",
      "const zip = zipFiles([{ path: 'a.js', data: Buffer.from('a') }], new Date(Date.UTC(2026, 9, 25, 23, 30, 0)));",
      "console.log(createHash('sha256').update(zip).digest('hex'));",
    ].join('\n');
    const hashes = ['UTC', 'Pacific/Kiritimati', 'America/Adak'].map((tz) => {
      const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
        encoding: 'utf8',
        env: { ...process.env, TZ: tz },
      });
      expect(result.status, result.stderr).toBe(0);
      return result.stdout.trim();
    });
    expect(new Set(hashes).size).toBe(1);
  });

  it('carries no extra fields, comments or data descriptors, and one made-by value and file mode', () => {
    for (const entry of readZip(pack(writeTree(FILES))).entries) {
      expect(entry.extraLength).toBe(0);
      expect(entry.local.extraLength).toBe(0);
      expect(entry.commentLength).toBe(0);
      expect(entry.flags & 0x0008).toBe(0); // no data descriptor
      expect(entry.flags).toBe(0);
      expect(entry.local.flags).toBe(0);
      expect(entry.madeBy).toBe((3 << 8) | 20); // Unix, specification 2.0
      expect(entry.needed).toBe(10);
      expect(entry.local.needed).toBe(10);
      expect(entry.internal).toBe(0);
      expect(entry.external >>> 16).toBe(0o100644);
      expect(entry.external & 0xffff).toBe(0);
    }
  });

  it('marks a name outside printable ASCII as UTF-8', () => {
    const { entries } = readZip(zipFiles([{ path: 'popup/\u00e9t\u00e9.js', data: Buffer.from('x') }], SOURCE_DATE));
    expect(entries[0].name).toBe('popup/\u00e9t\u00e9.js');
    expect(entries[0].flags).toBe(0x0800);
    expect(entries[0].local.flags).toBe(0x0800);
  });

  it('clamps a date to the range a zip entry can hold', () => {
    expect(dosDateTime(new Date(Date.UTC(1970, 0, 1)))).toEqual({ time: 0, date: (1 << 5) | 1 });
    expect(dosDateTime(EARLIEST_ZIP_DATE)).toEqual({ time: 0, date: (1 << 5) | 1 });
    expect(dosDateTime(new Date(Date.UTC(2200, 0, 1)))).toEqual({
      time: (23 << 11) | (59 << 5) | 29,
      date: ((2107 - 1980) << 9) | (12 << 5) | 31,
    });
    expect(() => dosDateTime(new Date(Number.NaN))).toThrow(/not a valid date/);
  });

  it('gives the time a zip entry carries: the date clamped to 1980 to 2107 and rounded down to an even second', () => {
    expect(EARLIEST_ZIP_DATE.toISOString()).toBe('1980-01-01T00:00:00.000Z');
    expect(LATEST_ZIP_DATE.toISOString()).toBe('2107-12-31T23:59:58.000Z');
    for (const [date, carried] of ENTRY_DATES) {
      expect(zipEntryDate(date).toISOString(), date.toISOString()).toBe(carried);
      const { time, date: day } = dosDateTime(date);
      expect(dosTimeIso(time, day), `the MS-DOS fields for ${date.toISOString()}`).toBe(carried);
    }
    expect(() => zipEntryDate(new Date(Number.NaN))).toThrow(/not a valid date/);
  });

  it('reports the time the entries it packed carry', () => {
    const dir = writeTree(FILES);
    for (const [date, carried] of ENTRY_DATES) {
      const out = join(tempDir(), 'dist.zip');
      expect(packDirectory(dir, out, date).entryDate.toISOString(), date.toISOString()).toBe(carried);
      const times = new Set(readZip(readFileSync(out)).entries.flatMap(({ time, date: day, local }) => [
        dosTimeIso(time, day), dosTimeIso(local.time, local.date),
      ]));
      expect([...times], `the entries packed for ${date.toISOString()}`).toEqual([carried]);
    }
  });

  it('refuses a path a zip entry should not hold, and a path listed twice', () => {
    const data = Buffer.from('x');
    for (const path of ['', '/etc/passwd', '../outside.js', 'popup/../../outside.js', 'popup//index.html', 'popup\\index.html', './a.js', 'a\nb.js']) {
      expect(() => zipFiles([{ path, data }], SOURCE_DATE), JSON.stringify(path)).toThrow(/not a relative path/);
    }
    expect(() => zipFiles([{ path: 'a.js', data }, { path: 'a.js', data }], SOURCE_DATE)).toThrow(/listed twice/);
  });

  it.skipIf(!POSIX)('refuses a symbolic link under the directory and writes no archive', () => {
    const outside = writeTree({ 'secret.txt': 'a file outside the directory\n' });
    const dir = writeTree(FILES);
    symlinkSync(join(outside, 'secret.txt'), join(dir, 'popup/linked.js'));
    const out = join(tempDir(), 'dist.zip');
    expect(() => packDirectory(dir, out, SOURCE_DATE)).toThrow(/popup\/linked\.js is a symbolic link/);
    expect(existsSync(out)).toBe(false);
    expect(existsSync(`${out}.partial`)).toBe(false);
  });

  it('leaves no partial archive behind when the archive cannot be put in place', () => {
    const dir = writeTree(FILES);
    const outDir = tempDir();
    const out = join(outDir, 'dist.zip');
    mkdirSync(join(out, 'occupied'), { recursive: true }); // a directory where the archive goes
    expect(() => packDirectory(dir, out, SOURCE_DATE)).toThrow();
    expect(readdirSync(outDir)).toEqual(['dist.zip']);
    expect(readdirSync(out)).toEqual(['occupied']);
  });

  it.skipIf(!HAS_UNZIP)('is read back whole by unzip', () => {
    const out = join(tempDir(), 'dist.zip');
    packDirectory(writeTree(FILES), out, SOURCE_DATE);
    expect(spawnSync('unzip', ['-tq', out]).status).toBe(0);
    const extracted = tempDir();
    expect(spawnSync('unzip', ['-q', out, '-d', extracted]).status).toBe(0);
    for (const [path, content] of Object.entries(FILES)) {
      expect(readFileSync(join(extracted, path), 'utf8')).toBe(content);
    }
  });
});

describe('source date of the package', () => {
  it('is SOURCE_DATE_EPOCH when it is set', () => {
    const { date, source } = sourceDate(tempDir(), { SOURCE_DATE_EPOCH: '1792911311' });
    expect(source).toBe('SOURCE_DATE_EPOCH');
    expect(date.getTime()).toBe(1792911311 * 1000);
  });

  it('stops packing when SOURCE_DATE_EPOCH is not a whole number of seconds', () => {
    for (const value of ['soon', '-1', '1.5', '1e9', ' 1']) {
      expect(() => sourceDate(tempDir(), { SOURCE_DATE_EPOCH: value }), value).toThrow(/whole number of seconds/);
    }
  });

  it.skipIf(!HAS_GIT)('is the commit time of HEAD at the top of a git checkout', () => {
    const repo = tempDir();
    const env = {
      ...process.env,
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_AUTHOR_DATE: '@1700000000 +0000',
      GIT_COMMITTER_DATE: '@1700000123 +0000',
    };
    const git = (...args: string[]) => {
      const result = spawnSync('git', ['-c', 'user.name=Build test', '-c', 'user.email=build-test@example.invalid', '-c', 'commit.gpgsign=false', ...args], { cwd: repo, env, encoding: 'utf8' });
      expect(result.status, result.stderr).toBe(0);
    };
    git('init', '-q');
    git('commit', '-q', '--no-verify', '--allow-empty', '-m', 'source date');
    mkdirSync(join(repo, 'sub'));

    expect(sourceDate(repo, {})).toEqual({ date: new Date(1700000123 * 1000), source: 'commit' });
    // Below the top of the checkout the build is not at a commit of its own.
    expect(sourceDate(join(repo, 'sub'), {})).toEqual({ date: EARLIEST_ZIP_DATE, source: 'none' });
  });

  it('is the earliest zip date outside a git checkout', () => {
    expect(sourceDate(tempDir(), {})).toEqual({ date: EARLIEST_ZIP_DATE, source: 'none' });
  });
});
