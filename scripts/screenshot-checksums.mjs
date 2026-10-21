/**
 * docs/screenshots/checksums.json records the SHA-256 of each image the two
 * screenshot generators write:
 *
 * - `popupCaptures.files`: the popup captures from scripts/generate-screenshots.mjs.
 * - `storeImages.files`: the store slides and promo tiles from
 *   docs/screenshots/capture.mjs.
 * - `storeImages.embeddedPopupCaptures`: the popup captures that
 *   docs/screenshots/generate.html embedded when capture.mjs ran.
 *
 * Each generator replaces its own section after a run.
 * src/__tests__/store-screenshots.test.ts fails when a committed image differs
 * from the checksum its generator recorded, or when the store images were
 * captured from popup captures other than the committed ones.
 */
import { createHash } from 'crypto';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

/**
 * SHA-256 (hex) of each named file in `dir`, keyed by name in sorted order.
 *
 * @param {string} dir
 * @param {string[]} names
 * @returns {Record<string, string>}
 */
export function checksumsOf(dir, names) {
  return Object.fromEntries(
    [...names].sort().map((name) => [name, createHash('sha256').update(readFileSync(join(dir, name))).digest('hex')]),
  );
}

/**
 * Replace the `section` entry of checksums.json in `dir`, keeping the other
 * sections.
 *
 * @param {string} dir
 * @param {string} section
 * @param {object} value
 */
export function recordChecksums(dir, section, value) {
  const path = join(dir, 'checksums.json');
  const record = existsSync(path) ? JSON.parse(readFileSync(path, 'utf-8')) : {};
  record[section] = value;
  const sorted = Object.fromEntries(Object.keys(record).sort().map((key) => [key, record[key]]));
  writeFileSync(path, JSON.stringify(sorted, null, 2) + '\n');
  console.log(`Recorded ${section} checksums in ${path}`);
}
