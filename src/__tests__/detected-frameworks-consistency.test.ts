/**
 * The README's Detected Frameworks section states what each detection checks
 * and what it has been checked against. Those statements must match the code
 * and the harnesses in scripts/.
 *
 * The section once said every method had been verified against the real
 * framework, and that Operator was detected the same way as Playwright. No
 * harness drives Operator, and detectOpenAIOperator() in
 * src/detection/automation.ts reads environment signals only, with no input
 * from Playwright detection.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'fs';

function read(relPath: string): string {
  return readFileSync(new URL(`../../${relPath}`, import.meta.url), 'utf-8');
}

function detectedFrameworksSection(): string {
  const readme = read('README.md');
  const start = readme.indexOf('## Detected Frameworks');
  expect(start, 'README.md has no "## Detected Frameworks" section').toBeGreaterThanOrEqual(0);
  const end = readme.indexOf('\n## ', start + 1);
  return readme.slice(start, end === -1 ? undefined : end);
}

function tableRow(section: string, framework: string): string {
  const row = section.split('\n').find((line) => line.startsWith(`| ${framework} |`));
  expect(row, `no "${framework}" row in the Detected Frameworks table`).toBeDefined();
  return row as string;
}

describe('README Detected Frameworks section', () => {
  it('does not claim every method was verified against the real framework', () => {
    expect(detectedFrameworksSection()).not.toMatch(/every method[^.]*verified/i);
  });

  it('names only scripts that exist', () => {
    const paths = [...detectedFrameworksSection().matchAll(/`(scripts\/[^`\s]+)`/g)].map((m) => m[1]);
    expect(paths.length).toBeGreaterThan(0);
    for (const path of paths) {
      expect(existsSync(new URL(`../../${path}`, import.meta.url)), `${path} does not exist`).toBe(true);
    }
  });

  it('describes the Operator row as detectOpenAIOperator() does', () => {
    const row = tableRow(detectedFrameworksSection(), 'OpenAI Operator');
    expect(row).not.toMatch(/same as playwright/i);
    expect(row).not.toMatch(/uses playwright internally/i);
    // The signals detectOpenAIOperator() checks, and its two-signal threshold.
    for (const signal of ['Linux', '`Operator`', '`OpenAI`', 'zero browser plugins', 'SwiftShader', 'llvmpipe', 'ANGLE', 'Google']) {
      expect(row, `Operator row does not name "${signal}"`).toContain(signal);
    }
    expect(row).toMatch(/any two/i);
  });
});
