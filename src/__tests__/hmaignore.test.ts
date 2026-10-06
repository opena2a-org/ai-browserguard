/**
 * Scanner suppressions in .hmaignore stay narrow.
 *
 * HackMyAgent's NEMO-009 check reports the browser automation helper
 * page.$eval in the smoke scripts as a call to eval. .hmaignore leaves that
 * one check out for those files only. These cases keep each rule scoped to
 * one check on one file with a reason, and fail if a suppressed file gains a
 * real eval call or Function constructor call that the rule would hide.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'fs';
import { fileURLToPath } from 'url';

const ROOT = new URL('../../', import.meta.url);
const RULE = /^(\S+):([A-Z][A-Z0-9]*(?:-[A-Z0-9]+)+)\s+#\s+\S/;

function readRules(): string[] {
  return readFileSync(new URL('.hmaignore', ROOT), 'utf-8')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'));
}

function parse(rule: string): { path: string; checkId: string } {
  const m = rule.match(RULE);
  if (!m) throw new Error(`not a <path>:<CHECK-ID> # <reason> rule: ${rule}`);
  return { path: m[1], checkId: m[2] };
}

describe('.hmaignore', () => {
  it('leaves NEMO-009 out for the two smoke scripts that call page.$eval', () => {
    const rules = readRules().map(parse);
    expect(rules).toContainEqual({ path: 'scripts/smoke-export.mjs', checkId: 'NEMO-009' });
    expect(rules).toContainEqual({ path: 'scripts/smoke-scope.mjs', checkId: 'NEMO-009' });
  });

  it('scopes every rule to one check on one file and gives a reason', () => {
    for (const rule of readRules()) {
      expect(rule, 'repo-wide !CHECK rules hide the check everywhere').not.toMatch(/^!/);
      expect(rule, 'globs are not supported by the scanner').not.toContain('*');
      const { path } = parse(rule);
      expect(existsSync(fileURLToPath(new URL(path, ROOT))), `${path} does not exist`).toBe(true);
    }
  });

  it('suppresses NEMO-009 only where the file calls page.$eval and never eval or the Function constructor', () => {
    const nemo009 = readRules().map(parse).filter((r) => r.checkId === 'NEMO-009');
    expect(nemo009.length).toBeGreaterThan(0);
    for (const { path } of nemo009) {
      const src = readFileSync(new URL(path, ROOT), 'utf-8');
      expect(src, `${path} no longer calls page.$eval; remove its rule`).toMatch(/\.\$eval\s*\(/);
      expect(src, `${path} calls eval`).not.toMatch(/(?<![\w$])eval\s*\(/);
      expect(src, `${path} calls the Function constructor`).not.toMatch(/\bnew\s+Function\s*\(/);
    }
  });
});
