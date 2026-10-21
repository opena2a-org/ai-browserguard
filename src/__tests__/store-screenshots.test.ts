import { describe, it, expect } from 'vitest';
import { createHash } from 'crypto';
import { readdirSync, readFileSync } from 'fs';
import { join, resolve } from 'path';

/**
 * Lock-in: the committed store screenshots and promo tiles are the images the
 * two screenshot generators last wrote, and the store images embed the
 * committed popup captures.
 *
 * scripts/generate-screenshots.mjs captures the built popup (1-detection.png
 * to 4-killswitch.png). docs/screenshots/capture.mjs captures the store slides
 * and promo tiles from docs/screenshots/generate.html, a page that embeds
 * those popup captures. Each script records the checksums of the images it
 * wrote in docs/screenshots/checksums.json. When only 2-delegation.png and
 * store-2-delegation.png were regenerated, 1-detection.png, 3-readOnly.png,
 * 4-killswitch.png and the store images that embed them kept an earlier popup
 * header and a "v0.1.0" footer, so the four store screenshots showed two
 * popup designs (#161).
 */

const ROOT = resolve(__dirname, '../..');
const DIR = join(ROOT, 'docs/screenshots');
const REGENERATE =
  'run npm run build, node scripts/generate-screenshots.mjs and node docs/screenshots/capture.mjs, ' +
  'then commit every image they wrote together with docs/screenshots/checksums.json';

interface ChecksumRecord {
  popupCaptures: { files: Record<string, string> };
  storeImages: { files: Record<string, string>; embeddedPopupCaptures: Record<string, string> };
}

const record: ChecksumRecord = JSON.parse(readFileSync(join(DIR, 'checksums.json'), 'utf-8'));
const RECORDED: Array<[string, string]> = [
  ...Object.entries(record.popupCaptures.files),
  ...Object.entries(record.storeImages.files),
];

function sha256(name: string): string {
  return createHash('sha256').update(readFileSync(join(DIR, name))).digest('hex');
}

describe('store screenshots', () => {
  it('checksums.json records each committed image once', () => {
    const committed = readdirSync(DIR).filter((name) => name.endsWith('.png')).sort();
    expect(RECORDED.map(([name]) => name).sort(), REGENERATE).toEqual(committed);
  });

  it.each(RECORDED)('%s is the image its generator last wrote', (name, checksum) => {
    expect(sha256(name), REGENERATE).toBe(checksum);
  });

  it('the store slides and promo tiles embed the committed popup captures', () => {
    expect(record.storeImages.embeddedPopupCaptures, REGENERATE).toEqual(record.popupCaptures.files);
  });

  it('the popup captures hide the footer, which names the build version', () => {
    const generator = readFileSync(join(ROOT, 'scripts/generate-screenshots.mjs'), 'utf-8');
    expect(generator).toContain("document.getElementById('footer').classList.add('hidden')");
  });
});
