/**
 * Release metadata consistency.
 *
 * The version is declared in manifest.json, package.json, CHANGELOG.md, and
 * STATUS.md. build.js fails at build time if manifest and package drift, but
 * that is not a CI gate. This test makes the version match (and the homepage
 * URL domain) a unit-test gate so a forgotten bump or a phishing-domain
 * homepage is caught in CI, not at the Web Store.
 *
 * The heading of docs/chrome-web-store-description.md names the release its
 * text is for. It once named v0.7.0 while the introduction under it said the
 * text was for the v0.6.0 submission, so the last block holds the heading to
 * manifest.json and keeps the file from naming another release as the
 * submission its text is for.
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

  it('CONTRIBUTING.md has the changelog heading renamed before `npm run bump` (#134)', () => {
    // npm run bump does not edit CHANGELOG.md, so a bump run before the rename
    // fails the test above and is reverted.
    const contributing = read('CONTRIBUTING.md');
    const rename = contributing.indexOf('rename the `## [Unreleased]` heading to the new version');
    expect(rename).toBeGreaterThan(-1);
    expect(contributing.indexOf('Run `npm run bump', rename)).toBeGreaterThan(rename);
  });

  it('STATUS.md states the current version', () => {
    const statusVer = read('STATUS.md').match(/currently at v(\d+\.\d+\.\d+)/)?.[1];
    expect(statusVer).toBe(manifest.version);
  });

  it('homepage_url points to the official opena2a.org domain over https', () => {
    expect(manifest.homepage_url).toMatch(/^https:\/\/(www\.)?opena2a\.org\//);
  });
});

describe('the store submission text names the release in manifest.json (#115)', () => {
  const manifest = JSON.parse(read('manifest.json')) as { version: string };
  const storeText = read('docs/chrome-web-store-description.md');

  it('in its heading', () => {
    expect(storeText.match(/^# .*\(v(\d+\.\d+\.\d+)\)$/m)?.[1]).toBe(manifest.version);
  });

  it('and names no other release as the submission its text is for', () => {
    // Prose wraps, so a phrase can span a line break.
    const named = [...storeText.replace(/\s+/g, ' ').matchAll(/\bv?(\d+\.\d+\.\d+) (?:re)?submission\b/g)];
    expect(named.map((match) => match[1]).filter((version) => version !== manifest.version)).toEqual([]);
  });

  it('CONTRIBUTING.md has that heading changed before `npm run bump`', () => {
    // npm run bump does not edit the store text, so a bump run before the
    // change fails the first test in this block and is reverted.
    const contributing = read('CONTRIBUTING.md');
    const change = contributing.indexOf('In `docs/chrome-web-store-description.md`, change the version in the heading');
    expect(change).toBeGreaterThan(-1);
    expect(contributing.indexOf('Run `npm run bump', change)).toBeGreaterThan(change);
  });
});
