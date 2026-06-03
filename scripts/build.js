/**
 * Build script for AI Browser Guard Chrome extension.
 *
 * Builds each entry point separately to avoid shared chunk issues.
 * Content scripts need IIFE format (no ES module imports).
 * Background and popup can use ES modules.
 * Copies manifest.json (with corrected paths) and icons into dist/.
 */

import { execSync } from 'child_process';
import { rmSync, existsSync, mkdirSync, copyFileSync, readFileSync, writeFileSync, renameSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const root = resolve(__dirname, '..');

const entries = ['content', 'interceptor', 'background', 'popup'];

// Version consistency check: manifest.json and package.json must agree
const manifestData = JSON.parse(readFileSync(resolve(root, 'manifest.json'), 'utf-8'));
const packageData = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf-8'));
if (manifestData.version !== packageData.version) {
  console.error(
    `\nVersion mismatch: manifest.json has ${manifestData.version}, package.json has ${packageData.version}.` +
    `\nUpdate both files to the same version before building.`
  );
  process.exit(1);
}
console.log(`Building AI Browser Guard v${manifestData.version}\n`);

// Archive the previous build before wiping it. We keep every prior dist/ (and
// any prior packaged dist.zip) under dist-archive/ rather than deleting, so a
// rejected/older build can always be re-inspected or re-loaded. dist-archive/
// is gitignored.
const archiveDir = resolve(root, 'dist-archive');
const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '-');
mkdirSync(archiveDir, { recursive: true });

const prevManifestPath = resolve(root, 'dist', 'manifest.json');
if (existsSync(prevManifestPath)) {
  try {
    const prevVer = JSON.parse(readFileSync(prevManifestPath, 'utf-8')).version ?? 'unknown';
    const zipPath = resolve(archiveDir, `dist-v${prevVer}-${stamp}.zip`);
    execSync(`zip -qr "${zipPath}" .`, { cwd: resolve(root, 'dist') });
    console.log(`Archived previous build -> dist-archive/dist-v${prevVer}-${stamp}.zip`);
  } catch (err) {
    console.warn(`Could not archive previous dist/: ${err.message}`);
  }
}
// Move any existing packaged dist.zip into the archive too.
if (existsSync(resolve(root, 'dist.zip'))) {
  renameSync(resolve(root, 'dist.zip'), resolve(archiveDir, `dist-package-${stamp}.zip`));
  console.log(`Archived previous dist.zip -> dist-archive/dist-package-${stamp}.zip`);
}

// Clean dist
if (existsSync('dist')) {
  rmSync('dist', { recursive: true, force: true });
}

for (const entry of entries) {
  console.log(`\nBuilding ${entry}...`);
  execSync(`ENTRY=${entry} npx vite build`, { stdio: 'inherit' });
}

// Copy and adjust manifest.json for dist/ as root
const manifest = JSON.parse(readFileSync(resolve(root, 'manifest.json'), 'utf-8'));
manifest.background.service_worker = 'background/index.js';
manifest.content_scripts[0].js = ['content/index.js'];
manifest.content_scripts[1].js = ['content/interceptor.js'];
manifest.action.default_popup = 'popup/index.html';
writeFileSync(resolve(root, 'dist', 'manifest.json'), JSON.stringify(manifest, null, 2));

// Copy icons
const iconsDir = resolve(root, 'dist', 'icons');
mkdirSync(iconsDir, { recursive: true });
for (const icon of ['icon16.png', 'icon48.png', 'icon128.png']) {
  copyFileSync(resolve(root, 'icons', icon), resolve(iconsDir, icon));
}

// Copy fonts
const fontsDir = resolve(root, 'dist', 'fonts');
mkdirSync(fontsDir, { recursive: true });
copyFileSync(resolve(root, 'fonts', 'inter-latin.woff2'), resolve(fontsDir, 'inter-latin.woff2'));

// Inject version into popup HTML (replaces __VERSION__ placeholder)
const popupHtmlPath = resolve(root, 'dist', 'popup', 'index.html');
if (existsSync(popupHtmlPath)) {
  const html = readFileSync(popupHtmlPath, 'utf-8');
  writeFileSync(popupHtmlPath, html.replace(/__VERSION__/g, manifestData.version));
}

// Package the fresh build into dist.zip for Web Store upload. The previous
// dist.zip (if any) was already moved into dist-archive/ above.
try {
  execSync(`zip -qr "${resolve(root, 'dist.zip')}" .`, { cwd: resolve(root, 'dist') });
  console.log('Packaged dist/ -> dist.zip');
} catch (err) {
  console.warn(`Could not package dist.zip: ${err.message}`);
}

console.log('\nBuild complete. Load dist/ in chrome://extensions');
