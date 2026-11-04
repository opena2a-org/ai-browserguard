/**
 * scripts/content-digest.mjs computes the content digest of dist/: the
 * sha256 of a text made of one `<sha256 of file>  <path>` line per file,
 * sorted bytewise by path, each line ending in a newline. The release test
 * and the store publish workflow compare builds by this value, because it
 * leaves out the zip container.
 *
 * The expected values here are built from that definition with node:crypto
 * directly, never with the script, so each case checks the script against
 * the definition. Each case writes its own directory under the system temp
 * directory.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'child_process';
import { createHash } from 'crypto';
import { mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { contentDigest, contentDigestLines, listFiles } from '../../scripts/content-digest.mjs';

const SCRIPT = fileURLToPath(new URL('../../scripts/content-digest.mjs', import.meta.url));
const HAS_SHASUM =
  process.platform !== 'win32' && spawnSync('sh', ['-c', 'command -v shasum'], { stdio: 'ignore' }).status === 0;

const sha256 = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');
const byteOrder = (a: string, b: string) => Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));

// Upper case sorts before lower case, and a hyphen (0x2d) before a slash (0x2f).
const FILES: Record<string, string> = {
  'manifest.json': '{"manifest_version":3}\n',
  'popup/index.html': '<!doctype html>\n',
  'popup/popup.js': 'console.log("popup");\n',
  'Background.js': 'upper case\n',
  'a-b.js': 'hyphen\n',
  'a/b.js': 'slash\n',
};

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'abg-digest-'));
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

// The definition, written out.
function definedLines(files: Record<string, string>): string[] {
  return Object.keys(files).sort(byteOrder).map((path) => `${sha256(files[path])}  ${path}`);
}

function definedDigest(files: Record<string, string>): string {
  return sha256(definedLines(files).map((line) => `${line}\n`).join(''));
}

describe('content digest of a built directory', () => {
  it('is the sha256 of one line per file, in bytewise path order', () => {
    const dir = writeTree(FILES);
    expect(contentDigestLines(dir)).toEqual(definedLines(FILES));
    expect(contentDigest(dir)).toBe(definedDigest(FILES));
    expect(listFiles(dir).map(({ path }) => path)).toEqual([
      'Background.js', 'a-b.js', 'a/b.js', 'manifest.json', 'popup/index.html', 'popup/popup.js',
    ]);
  });

  it('orders paths by their UTF-8 bytes, not by UTF-16 code units', () => {
    // U+FF21 is EF BC A1 in UTF-8 and U+10400 is F0 90 90 80, so bytewise
    // U+FF21 comes first; as UTF-16 code units (0xFF21 against 0xD801) the
    // order is the other way round.
    const files = { '\u{10400}.js': 'deseret\n', '\uFF21.js': 'fullwidth\n', 'z.js': 'ascii\n' };
    const dir = writeTree(files);
    expect(listFiles(dir).map(({ path }) => path)).toEqual(['z.js', '\uFF21.js', '\u{10400}.js']);
    expect(contentDigest(dir)).toBe(definedDigest(files));
  });

  it('does not change with file times or the order the files were written in', () => {
    const first = writeTree(FILES);
    const second = writeTree(FILES, Object.keys(FILES).reverse());
    for (const [index, path] of Object.keys(FILES).entries()) {
      utimesSync(join(second, path), 1_000_000 + index, 2_000_000 + index * 7);
    }
    expect(contentDigest(second)).toBe(contentDigest(first));
  });

  it('changes when one byte of a file changes, or when a file moves', () => {
    const dir = writeTree(FILES);
    const before = contentDigest(dir);

    writeFileSync(join(dir, 'popup/popup.js'), 'console.log("popuq");\n');
    const edited = contentDigest(dir);
    expect(edited).not.toBe(before);

    renameSync(join(dir, 'a-b.js'), join(dir, 'a-c.js'));
    expect(contentDigest(dir)).not.toBe(edited);
  });

  it.skipIf(process.platform === 'win32')('refuses a symbolic link instead of following it', () => {
    const outside = writeTree({ 'target.txt': 'a file outside the directory\n' });
    const dir = writeTree(FILES);
    symlinkSync(join(outside, 'target.txt'), join(dir, 'popup/linked.js'));
    expect(() => listFiles(dir)).toThrow(/popup\/linked\.js is a symbolic link/);
    expect(() => contentDigest(dir)).toThrow(/symbolic link/);
  });

  it('refuses a directory that holds no files', () => {
    const dir = tempDir();
    mkdirSync(join(dir, 'empty'));
    expect(() => contentDigest(dir)).toThrow(/holds no files/);
  });

  it('prints the digest, or the lines with --list, and exits 1 when the directory cannot be read', () => {
    const dir = writeTree(FILES);

    const digest = spawnSync(process.execPath, [SCRIPT, dir], { encoding: 'utf8' });
    expect(digest.status).toBe(0);
    expect(digest.stdout).toBe(`${definedDigest(FILES)}\n`);

    const lines = spawnSync(process.execPath, [SCRIPT, dir, '--list'], { encoding: 'utf8' });
    expect(lines.status).toBe(0);
    expect(lines.stdout).toBe(definedLines(FILES).map((line) => `${line}\n`).join(''));

    const missing = spawnSync(process.execPath, [SCRIPT, join(dir, 'not-there')], { encoding: 'utf8' });
    expect(missing.status).toBe(1);
    expect(missing.stdout).toBe('');
    expect(missing.stderr).toContain('Could not compute the content digest');
  });

  it.skipIf(!HAS_SHASUM)('equals the value shasum prints for the same files', () => {
    const dir = writeTree(FILES);
    const byHand = spawnSync(
      'sh',
      ['-c', `cd "$1" && find . -type f | sed 's|^\\./||' | LC_ALL=C sort | while IFS= read -r f; do shasum -a 256 "$f"; done | shasum -a 256`, 'sh', dir],
      { encoding: 'utf8' },
    );
    expect(byHand.status).toBe(0);
    expect(byHand.stdout.split(/\s+/)[0]).toBe(contentDigest(dir));
  });
});
