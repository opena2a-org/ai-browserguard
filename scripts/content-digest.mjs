#!/usr/bin/env node
/**
 * Content digest of a built extension directory (dist/ by default).
 *
 * The digest is the sha256 of a text made of one line per file,
 *
 *   <sha256 of the file>  <path relative to the directory>
 *
 * sorted bytewise by path, each line ending in a newline. It covers what the
 * files hold and where they sit, and nothing about a zip container, so two
 * builds can be compared even when their archives differ. The lines have the
 * format `shasum -a 256` prints, so the digest can be checked by hand:
 *
 *   (cd dist && find . -type f | sed 's|^\./||' | LC_ALL=C sort |
 *     while IFS= read -r f; do shasum -a 256 "$f"; done) | shasum -a 256
 *
 * Only regular files and directories are accepted. A symbolic link or any
 * other kind of entry is refused, so neither the digest nor the package
 * written from the same list (scripts/deterministic-zip.mjs) can take in a
 * file from outside the directory.
 *
 * Usage: node scripts/content-digest.mjs [dir] [--list]
 * Prints the digest of dir (default dist), or with --list the lines it is
 * computed from. Exits 1 with the reason when the directory cannot be read.
 */
import { createHash } from 'crypto';
import { lstatSync, readdirSync, readFileSync, statSync } from 'fs';
import { join, resolve } from 'path';
import { pathToFileURL } from 'url';

const byteOrder = (a, b) => Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));

/**
 * The regular files under dir as { path, file }: path is relative to dir
 * with '/' separators, file is the absolute path. Sorted bytewise by path.
 * Throws when dir is not a directory, holds no files, or holds an entry that
 * is neither a regular file nor a directory.
 */
export function listFiles(dir) {
  const root = resolve(dir);
  let rootStat;
  try {
    rootStat = statSync(root);
  } catch (err) {
    throw new Error(`cannot read ${dir} (${err.code ?? err.message})`);
  }
  if (!rootStat.isDirectory()) throw new Error(`${dir} is not a directory`);

  const files = [];
  const walk = (absolute, relative) => {
    for (const name of readdirSync(absolute)) {
      const path = relative ? `${relative}/${name}` : name;
      if (/[\n\r\\]/.test(name)) {
        throw new Error(`${JSON.stringify(path)}: a file name may not contain a newline or a backslash`);
      }
      const file = join(absolute, name);
      const stat = lstatSync(file);
      if (stat.isDirectory()) walk(file, path);
      else if (stat.isFile()) files.push({ path, file });
      else {
        const kind = stat.isSymbolicLink() ? 'a symbolic link' : 'not a regular file';
        throw new Error(`${path} is ${kind}; only regular files are accepted`);
      }
    }
  };
  walk(root, '');
  if (files.length === 0) throw new Error(`${dir} holds no files`);
  return files.sort((a, b) => byteOrder(a.path, b.path));
}

/** The lines the digest is computed from, `<sha256>  <path>`, in order. */
export function contentDigestLines(dir) {
  return listFiles(dir).map(({ path, file }) =>
    `${createHash('sha256').update(readFileSync(file)).digest('hex')}  ${path}`);
}

/** The content digest of dir, as 64 lowercase hex characters. */
export function contentDigest(dir) {
  const text = contentDigestLines(dir).map((line) => `${line}\n`).join('');
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  const list = args.includes('--list');
  const dirs = args.filter((arg) => arg !== '--list');
  if (dirs.length > 1 || dirs.some((arg) => arg.startsWith('-'))) {
    console.error('Usage: node scripts/content-digest.mjs [dir] [--list]');
    process.exit(2);
  }
  const dir = dirs[0] ?? 'dist';
  try {
    if (list) for (const line of contentDigestLines(dir)) console.log(line);
    else console.log(contentDigest(dir));
  } catch (err) {
    console.error(`Could not compute the content digest of ${dir}: ${err.message}`);
    process.exit(1);
  }
}
