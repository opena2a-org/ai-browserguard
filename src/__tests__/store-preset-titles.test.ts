import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { PRESET_TITLES } from '../delegation/rules';

/**
 * Lock-in: the store listing texts and the store screenshot generators name
 * the Limited Access preset by the title the delegation wizard shows.
 *
 * The store text is pasted into the Chrome Web Store dashboard and the
 * screenshots are generated from these two sources, so a reader who sees
 * "Limited" in the listing finds "Limited Access" in the wizard.
 * docs/store-description-v0.5.0.txt is a dated snapshot of an earlier release
 * and is left as it shipped.
 */

const STORE_FILES = [
  'docs/store-listing.md',
  'docs/chrome-web-store-description.md',
  'docs/screenshots/generate.html',
  'scripts/generate-screenshots.mjs',
];

const ROOT = resolve(__dirname, '../..');
const LIMITED_TITLE = PRESET_TITLES.limited;
// "Limited" as a word, not followed by the rest of the wizard title.
const SHORT_NAME_RE = /\bLimited\b(?! Access)/g;

function shortNameLines(content: string): string[] {
  const hits: string[] = [];
  content.split('\n').forEach((text, i) => {
    if (text.match(SHORT_NAME_RE)) hits.push(`line ${i + 1}: ${text.trim().slice(0, 80)}`);
  });
  return hits;
}

describe('store text preset titles', () => {
  it('the wizard titles the preset Limited Access', () => {
    expect(LIMITED_TITLE).toBe('Limited Access');
  });

  it.each(STORE_FILES)('%s names the preset Limited Access, not Limited', (relPath) => {
    const content = readFileSync(resolve(ROOT, relPath), 'utf-8');
    expect(shortNameLines(content)).toEqual([]);
    expect(content).toContain(LIMITED_TITLE);
  });

  it('flags the short name and accepts the wizard title', () => {
    expect(shortNameLines('Read-Only, Limited, or Full Access')).toEqual([
      'line 1: Read-Only, Limited, or Full Access',
    ]);
    expect(shortNameLines('<div class="preset-name">Limited</div>')).toHaveLength(1);
    expect(shortNameLines('Read-Only, Limited Access, or Full Access')).toEqual([]);
  });
});
