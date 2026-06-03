/**
 * Release metadata consistency.
 *
 * The version is declared in manifest.json, package.json, and CHANGELOG.md.
 * build.js fails at build time if manifest and package drift, but that is not a
 * CI gate. This test makes the three-way version match (and the homepage URL
 * domain) a unit-test gate so a forgotten bump or a phishing-domain homepage is
 * caught in CI, not at the Web Store.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';

function read(relPath: string): string {
  return readFileSync(new URL(`../../${relPath}`, import.meta.url), 'utf-8');
}

describe('release metadata is consistent', () => {
  const manifest = JSON.parse(read('manifest.json')) as { version: string; homepage_url?: string };
  const pkg = JSON.parse(read('package.json')) as { version: string };

  it('manifest, package, and changelog declare the same version', () => {
    const changelogVer = read('CHANGELOG.md').match(/^## ([\d.]+)/m)?.[1];
    expect(pkg.version).toBe(manifest.version);
    expect(changelogVer).toBe(manifest.version);
  });

  it('homepage_url points to the official opena2a.org domain over https', () => {
    expect(manifest.homepage_url).toMatch(/^https:\/\/(www\.)?opena2a\.org\//);
  });
});
