import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

/**
 * Lock-in: no web address in the store text ends in punctuation.
 *
 * These files are pasted as-is into the Chrome Web Store dashboard. A sentence
 * that ends on an address ("Learn more: https://opena2a.org.") hands the full
 * stop to a linkifier or to a reader copying the address, and the link they
 * get is wrong. Put the address on its own line, or reword so it does not end
 * a sentence.
 */

const STORE_TEXT_FILES = [
  'docs/chrome-web-store-description.md',
  'docs/store-description-v0.5.0.txt',
  'docs/store-listing.md',
];

const ROOT = resolve(__dirname, '../..');
const ADDRESS_RE = /https?:\/\/\S+/g;
const TRAILING_PUNCTUATION_RE = /[.,;:!?)\]'"]$/;

function addressesEndingInPunctuation(content: string): string[] {
  const hits: string[] = [];
  content.split('\n').forEach((text, i) => {
    for (const [address] of text.matchAll(ADDRESS_RE)) {
      if (TRAILING_PUNCTUATION_RE.test(address)) hits.push(`line ${i + 1}: ${address}`);
    }
  });
  return hits;
}

describe('store text addresses', () => {
  it.each(STORE_TEXT_FILES)('%s has no address followed directly by punctuation', (relPath) => {
    const content = readFileSync(resolve(ROOT, relPath), 'utf-8');
    expect(addressesEndingInPunctuation(content)).toEqual([]);
  });

  it('flags an address that ends a sentence', () => {
    expect(addressesEndingInPunctuation('Learn more: https://opena2a.org. Next.')).toEqual([
      'line 1: https://opena2a.org.',
    ]);
    expect(addressesEndingInPunctuation('Learn more: https://opena2a.org')).toEqual([]);
  });
});
