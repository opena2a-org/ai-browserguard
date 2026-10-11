#!/usr/bin/env node
/**
 * Prose punctuation check for the tracked Markdown a reader sees.
 *
 * Flags, in prose only (fenced code, inline code, front matter and HTML
 * comments are skipped):
 *   - a spaced double hyphen used as a dash (" -- ", or " --" ending a line)
 *   - an em dash (U+2014)
 *   - a spaced en dash (U+2013 with whitespace or a line edge on both sides)
 *   - a heading or bold section label named "Why this exists" or
 *     "Why this matters"
 *
 * Checked files: `git ls-files '*.md' '*.mdx'`, minus release history
 * (CHANGELOG.md, changelog.d/), license text, dependency and build output,
 * `.github/`, and test data directories, whose text is compared against.
 *
 * Usage: node scripts/check-docs-prose.mjs
 * Exits 1 and prints file:line for each finding; exits 0 when there are none.
 */
import { execFileSync } from 'child_process';
import { readFileSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const EXCLUDED_DIRS = new Set([
  '.github',
  'node_modules',
  'vendor',
  'dist',
  'build',
  'changelog.d',
  'test',
  'tests',
  '__tests__',
  'fixture',
  'fixtures',
  'corpus',
  'golden',
  'goldens',
  'snapshot',
  'snapshots',
  '__snapshots__',
  'example',
  'examples',
]);

// A double hyphen or en dash counts as a dash when whitespace or a line edge
// bounds it on both sides, which also covers one that ends a wrapped line.
const DASHES = [
  { pattern: /(?:^|\s)--(?:\s|$)/, message: 'spaced double hyphen used as a dash' },
  { pattern: /—/, message: 'em dash' },
  { pattern: /(?:^|\s)–(?:\s|$)/, message: 'spaced en dash' },
];
// Setext underlines, thematic breaks and table delimiter rows are not prose.
// One character class, not overlapping quantifiers, so a long whitespace run
// fails in linear time instead of backtracking for seconds.
const DELIMITER_ROW = /^[\s|:-]*$/;

const WHY_LABEL = /^\s{0,3}(?:#{1,6}\s+|\*\*|__)\s*why this (?:exists|matters)\b/i;
const WHY_SETEXT_TEXT = /^\s{0,3}why this (?:exists|matters)\b/i;
const SETEXT_UNDERLINE = /^\s{0,3}(?:=+|-+)\s*$/;
const FENCE_OPEN = /^\s{0,3}(`{3,}|~{3,})/;
const INLINE_CODE = /(`+)(?:[^`]|(?!\1)`)*?\1(?!`)/g;
const HTML_CODE = /<code\b[^>]*>[\s\S]*?<\/code>/gi;

/**
 * Whether a repository-relative path is in the checked set.
 *
 * @param {string} path forward-slash path relative to the repository root
 * @returns {boolean}
 */
export function isCheckedPath(path) {
  const parts = path.split('/');
  const base = parts[parts.length - 1];
  if (!/\.mdx?$/i.test(base)) return false;
  if (base === 'CHANGELOG.md' || /^LICENSE/i.test(base)) return false;
  return !parts.slice(0, -1).some((dir) => EXCLUDED_DIRS.has(dir));
}

/**
 * Find prose punctuation and section-name findings in one Markdown text.
 *
 * @param {string} text file contents
 * @returns {{ line: number, message: string }[]} 1-based line numbers
 */
export function findProseIssues(text) {
  const lines = text.split(/\r?\n/);
  const issues = [];
  let fence = null;
  let inComment = false;
  let start = 0;

  if (lines[0] === '---') {
    const end = lines.findIndex((l, i) => i > 0 && (l === '---' || l === '...'));
    if (end > 0) start = end + 1;
  }

  for (let i = start; i < lines.length; i++) {
    const raw = lines[i];

    if (fence) {
      const close = new RegExp(`^\\s{0,3}${fence[0] === '`' ? '`' : '~'}{${fence.length},}\\s*$`);
      if (close.test(raw)) fence = null;
      continue;
    }
    if (!inComment) {
      const open = FENCE_OPEN.exec(raw);
      if (open) {
        fence = open[1];
        continue;
      }
    }

    let prose = '';
    let rest = raw;
    while (rest.length > 0) {
      if (inComment) {
        const end = rest.indexOf('-->');
        if (end === -1) {
          rest = '';
        } else {
          rest = rest.slice(end + 3);
          inComment = false;
        }
      } else {
        const begin = rest.indexOf('<!--');
        if (begin === -1) {
          prose += rest;
          rest = '';
        } else {
          prose += rest.slice(0, begin);
          rest = rest.slice(begin + 4);
          inComment = true;
        }
      }
    }
    prose = prose.replace(HTML_CODE, '').replace(INLINE_CODE, '');

    if (!DELIMITER_ROW.test(prose)) {
      for (const { pattern, message } of DASHES) {
        if (pattern.test(prose)) issues.push({ line: i + 1, message });
      }
    }
    const next = lines[i + 1] ?? '';
    if (
      WHY_LABEL.test(prose) ||
      (WHY_SETEXT_TEXT.test(prose) && SETEXT_UNDERLINE.test(next) && next.trim() !== '')
    ) {
      issues.push({ line: i + 1, message: 'section named "Why this exists" or "Why this matters"' });
    }
  }
  return issues;
}

/**
 * Tracked Markdown files in the checked set, relative to `root`.
 *
 * @param {string} root repository root
 * @returns {string[]}
 */
export function listCheckedFiles(root) {
  const out = execFileSync('git', ['-C', root, 'ls-files', '-z', '--', '*.md', '*.mdx'], {
    encoding: 'utf-8',
  });
  return out.split('\0').filter((p) => p && isCheckedPath(p));
}

function main() {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const files = listCheckedFiles(root);
  let count = 0;
  for (const file of files) {
    for (const { line, message } of findProseIssues(readFileSync(join(root, file), 'utf-8'))) {
      console.log(`${file}:${line}: ${message}`);
      count++;
    }
  }
  if (count > 0) {
    console.log(
      `\n${count} finding(s) in ${files.length} checked files. Rewrite each dash as a period, ` +
        'comma, colon or parentheses, and fold a "Why this exists" section into the prose ' +
        'under the existing heading. Re-run: node scripts/check-docs-prose.mjs',
    );
    process.exit(1);
  }
  console.log(`Docs prose check: ${files.length} files, no findings.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main();
}
