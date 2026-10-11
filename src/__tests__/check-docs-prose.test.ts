/**
 * Docs prose check (scripts/check-docs-prose.mjs, run by `npm run lint`).
 *
 * Prose in the tracked docs uses no spaced double hyphen, em dash or spaced en
 * dash, and no section is named "Why this exists" or "Why this matters". Code
 * is exempt: a `--flag`, a POSIX `--` separator or a Mermaid `A -- B` edge is
 * not a dash. These cases pin both halves.
 */
import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'url';
import { findProseIssues, isCheckedPath, listCheckedFiles } from '../../scripts/check-docs-prose.mjs';

const lines = (text: string) => findProseIssues(text).map((issue) => issue.line);

describe('findProseIssues: dashes in prose', () => {
  it('flags a spaced double hyphen, an em dash and a spaced en dash', () => {
    const text = [
      'Detects agents -- and logs them.',
      'Detects agents—and logs them.',
      'Detects agents – and logs them.',
    ].join('\n');
    expect(findProseIssues(text)).toEqual([
      { line: 1, message: 'spaced double hyphen used as a dash' },
      { line: 2, message: 'em dash' },
      { line: 3, message: 'spaced en dash' },
    ]);
  });

  it('flags a double hyphen that ends or starts a wrapped line', () => {
    expect(lines('This privileged position --\ncontent scripts on every page')).toEqual([1]);
    expect(lines('This privileged position\n-- content scripts on every page')).toEqual([2]);
  });

  it('leaves hyphenated compounds, flags, arrows and unspaced ranges alone', () => {
    const text = [
      'An end-to-end check of the opt-in setting.',
      'Pass --maxWorkers=4 to limit workers.',
      'The flow is detect --> classify.',
      'PRs #47–#50 and pages 1–5.',
      '- a list item',
      '---',
      '| a | b |',
      '|---|:--:|',
      'Heading',
      '--',
    ].join('\n');
    expect(lines(text)).toEqual([]);
  });

  it('checks a line with a long whitespace run without stalling', () => {
    const run = ' '.repeat(4000);
    const started = Date.now();
    expect(lines(`${run}x`)).toEqual([]);
    expect(lines(`${run}x -- y`)).toEqual([1]);
    expect(lines(`${run}|---|:--:|${run}`)).toEqual([]);
    expect(Date.now() - started).toBeLessThan(1000);
  });
});

describe('findProseIssues: code is exempt', () => {
  it('skips fenced code blocks of either fence character', () => {
    const text = [
      '```mermaid',
      'CS -- "DETECTION_RESULT" --> BG',
      '```',
      '~~~',
      'npm test -- --watch',
      '~~~',
      'Prose -- here.',
    ].join('\n');
    expect(lines(text)).toEqual([7]);
  });

  it('does not close a fence on a shorter or different fence', () => {
    const text = ['````', '```', 'still code -- here', '~~~', '````', 'Prose -- here.'].join('\n');
    expect(lines(text)).toEqual([6]);
  });

  it('skips inline code spans, including double-backtick spans', () => {
    expect(lines('Run `npm test -- --watch` to iterate.')).toEqual([]);
    expect(lines('The span ``a ` b -- c`` stays code.')).toEqual([]);
    expect(lines('Run `npm test` -- then read the output.')).toEqual([1]);
  });

  it('skips HTML comments, front matter and <code> elements', () => {
    const text = [
      '---',
      'title: A -- B',
      '---',
      '<!-- note -- here',
      'still -- comment -->',
      'Use <code>a -- b</code> here.',
      'Prose — here.',
    ].join('\n');
    expect(lines(text)).toEqual([7]);
  });
});

describe('findProseIssues: section names', () => {
  it('flags a heading or bold label named "Why this exists" or "Why this matters"', () => {
    const text = [
      '## Why this exists',
      '### Why This Matters',
      '**Why this exists:** text',
      'Why this matters',
      '---',
    ].join('\n');
    expect(lines(text)).toEqual([1, 2, 3, 4]);
  });

  it('leaves the phrase alone in running prose', () => {
    expect(lines('That disclosure is why this ADR exists.\nWhy this exists is explained below.')).toEqual([]);
  });
});

describe('isCheckedPath', () => {
  it('checks the README and docs Markdown, including docs/testing', () => {
    for (const path of [
      'README.md',
      'STATUS.md',
      'docs/adr/007-cdp-layer-enforcement.md',
      'docs/testing/release-smoke.md',
      'docs/page.mdx',
    ]) {
      expect(isCheckedPath(path), path).toBe(true);
    }
  });

  it('excludes history, licenses, dependencies, build output, .github and test data', () => {
    for (const path of [
      'CHANGELOG.md',
      'changelog.d/0001-fix.md',
      'LICENSE.md',
      'node_modules/pkg/README.md',
      'vendor/lib/README.md',
      'dist/README.md',
      'build/notes.md',
      '.github/CONTRIBUTING.md',
      'test/fixtures/page.md',
      'src/__tests__/golden/out.md',
      'corpus/sample.md',
      'examples/input.md',
      'src/index.ts',
    ]) {
      expect(isCheckedPath(path), path).toBe(false);
    }
  });
});

describe('listCheckedFiles', () => {
  it('lists the tracked docs and leaves out the changelog', () => {
    const root = fileURLToPath(new URL('../../', import.meta.url));
    const files = listCheckedFiles(root);
    expect(files).toContain('README.md');
    expect(files).toContain('docs/architecture.md');
    expect(files).not.toContain('CHANGELOG.md');
  });
});
