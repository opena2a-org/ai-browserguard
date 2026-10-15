/**
 * The Detected Frameworks page (docs/detected-frameworks.md, moved there from
 * the README) states what each detection checks and what it has been checked
 * against. Those statements must match the code and the harnesses in scripts/.
 *
 * The section once said every method had been verified against the real
 * framework, and that Operator was detected the same way as Playwright. No
 * harness drives Operator, and detectOpenAIOperator() in
 * src/detection/automation.ts reads environment signals only, with no input
 * from Playwright detection.
 *
 * The page also said no harness drove Playwright. `npm run smoke:playwright`
 * now loads the built extension and drives a page with Playwright; the page
 * names it, and the script is held to the signals the Playwright row lists.
 *
 * The comments on detectOpenAIOperator() once said the same thing the README
 * did: that Playwright detection was the primary mechanism and the function
 * only added to it. They are held to the page's Operator row here.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'fs';

function read(relPath: string): string {
  return readFileSync(new URL(`../../${relPath}`, import.meta.url), 'utf-8');
}

function detectedFrameworksSection(): string {
  const page = read('docs/detected-frameworks.md');
  const start = page.indexOf('# Detected Frameworks');
  expect(start, 'docs/detected-frameworks.md has no "# Detected Frameworks" heading').toBeGreaterThanOrEqual(0);
  const end = page.indexOf('\n## ', start + 1);
  return page.slice(start, end === -1 ? undefined : end);
}

function tableRow(section: string, framework: string): string {
  const row = section.split('\n').find((line) => line.startsWith(`| ${framework} |`));
  expect(row, `no "${framework}" row in the Detected Frameworks table`).toBeDefined();
  return row as string;
}

/**
 * The docblock above detectOpenAIOperator() and the line comments inside it,
 * each unwrapped to one line so a phrase split across lines still matches.
 */
function operatorComments(): { docblock: string; inline: string } {
  const source = read('src/detection/automation.ts');
  const declaration = source.indexOf('export function detectOpenAIOperator(');
  expect(declaration, 'automation.ts has no detectOpenAIOperator()').toBeGreaterThanOrEqual(0);
  const docStart = source.lastIndexOf('/**', declaration);
  const rawDocblock = source.slice(docStart, declaration);
  expect(rawDocblock.trimEnd().endsWith('*/'), 'detectOpenAIOperator() has no docblock').toBe(true);
  const nextDocblock = source.indexOf('\n/**', declaration);
  const body = source.slice(declaration, nextDocblock === -1 ? undefined : nextDocblock);
  const docblock = rawDocblock
    .split('\n')
    .map((line) => line.replace(/^\s*(?:\/\*\*|\*\/|\*)\s?/, '').trim())
    .join(' ');
  const inline = body
    .split('\n')
    .filter((line) => /^\s*\/\//.test(line))
    .map((line) => line.replace(/^\s*\/\/\s?/, '').trim())
    .join(' ');
  return { docblock, inline };
}

describe('Detected Frameworks page', () => {
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

  it('names a harness that drives Playwright with the built extension loaded', () => {
    const section = detectedFrameworksSection();
    expect(section).not.toMatch(/no harness[^.]*playwright/i);
    expect(section).toContain('`npm run smoke:playwright`');
    expect(section).toContain('`scripts/smoke-playwright.mjs`');
    const scripts = JSON.parse(read('package.json')).scripts as Record<string, string>;
    expect(scripts['smoke:playwright']).toBe('node scripts/smoke-playwright.mjs');
    const harness = read('scripts/smoke-playwright.mjs');
    // The real framework, the built extension, and the two signals the
    // Playwright row lists.
    expect(harness).toContain("from 'playwright'");
    expect(harness).toContain('--load-extension=${distPath}');
    expect(harness).toContain('/UtilityScript/');
    expect(harness).toContain('chrome.debugger.getTargets');
    expect(harness).toContain("'Agent detected: Playwright'");
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

describe('detectOpenAIOperator() comments', () => {
  it('do not describe Playwright detection as part of the Operator check', () => {
    const { docblock, inline } = operatorComments();
    for (const text of [docblock, inline]) {
      expect(text).not.toMatch(/primary mechanism/i);
      expect(text).not.toMatch(/supplementary/i);
      expect(text).not.toMatch(/if playwright is detected/i);
      expect(text).not.toMatch(/combined with playwright/i);
    }
  });

  it('describe the check as the page row does', () => {
    const { docblock } = operatorComments();
    expect(docblock).toMatch(/environment signals only, separate from playwright detection/i);
    // The signals detectOpenAIOperator() checks, and its two-signal threshold.
    for (const signal of ['Linux', '"Operator"', '"OpenAI"', 'zero browser plugins', 'SwiftShader', 'llvmpipe', 'ANGLE', 'Google']) {
      expect(docblock, `Operator docblock does not name "${signal}"`).toContain(signal);
    }
    expect(docblock).toMatch(/any two/i);
    expect(docblock).toMatch(/not from a run against Operator/i);
  });
});
