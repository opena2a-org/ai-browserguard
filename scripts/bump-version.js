/**
 * Bump version across all files and update test count in README.
 *
 * Single command to keep everything in sync:
 *   npm run bump -- patch    # 0.2.0 -> 0.2.1
 *   npm run bump -- minor    # 0.2.0 -> 0.3.0
 *   npm run bump -- major    # 0.2.0 -> 1.0.0
 *   npm run bump -- 0.3.0    # explicit version
 *
 * What it updates:
 *   - manifest.json (version)
 *   - package.json (version)
 *   - STATUS.md (current version in the stage rationale)
 *   - README.md (test count badge + dev section test count)
 *   - popup HTML __VERSION__ placeholder is handled at build time by build.js
 *   - popup.ts reads chrome.runtime.getManifest().version at runtime as safety net
 */

import { execSync } from 'child_process';
import { readFileSync, writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const root = resolve(__dirname, '..');

const arg = process.argv[2];
if (!arg) {
  console.error('Usage: npm run bump -- <patch|minor|major|x.y.z>');
  process.exit(1);
}

// Read current version from manifest (single source of truth)
const manifestPath = resolve(root, 'manifest.json');
const packagePath = resolve(root, 'package.json');
const readmePath = resolve(root, 'README.md');
const statusPath = resolve(root, 'STATUS.md');

const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
const pkg = JSON.parse(readFileSync(packagePath, 'utf-8'));

const current = manifest.version;
const [major, minor, patch] = current.split('.').map(Number);

let newVersion;
switch (arg) {
  case 'patch':
    newVersion = `${major}.${minor}.${patch + 1}`;
    break;
  case 'minor':
    newVersion = `${major}.${minor + 1}.0`;
    break;
  case 'major':
    newVersion = `${major + 1}.0.0`;
    break;
  default:
    if (/^\d+\.\d+\.\d+$/.test(arg)) {
      newVersion = arg;
    } else {
      console.error(`Invalid version argument: ${arg}`);
      console.error('Use: patch, minor, major, or an explicit x.y.z version');
      process.exit(1);
    }
}

// 1. Update manifest.json, package.json, and STATUS.md
manifest.version = newVersion;
pkg.version = newVersion;
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
writeFileSync(packagePath, JSON.stringify(pkg, null, 2) + '\n');
const status = readFileSync(statusPath, 'utf-8');
writeFileSync(
  statusPath,
  status.replace(/currently at v\d+\.\d+\.\d+/, `currently at v${newVersion}`)
);
console.log(`Version: ${current} -> ${newVersion}`);

// 2. Run tests and capture the count
let testCount = null;
try {
  const testOutput = execSync('npx vitest run 2>&1', { cwd: root, encoding: 'utf-8' });
  const match = testOutput.match(/Tests\s+(\d+)\s+passed/);
  if (match) {
    testCount = parseInt(match[1], 10);
  }
} catch (err) {
  // Tests may have failed — extract count from stderr/stdout anyway
  const output = err.stdout ?? err.stderr ?? '';
  const match = output.match(/Tests\s+(\d+)\s+passed/);
  if (match) {
    testCount = parseInt(match[1], 10);
  }
  if (!testCount) {
    console.error('Tests failed. Fix tests before bumping.');
    // Revert version changes
    manifest.version = current;
    pkg.version = current;
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
    writeFileSync(packagePath, JSON.stringify(pkg, null, 2) + '\n');
    writeFileSync(statusPath, status);
    process.exit(1);
  }
}

// 3. Update README.md — test badge and dev section
if (testCount) {
  let readme = readFileSync(readmePath, 'utf-8');

  // Update badge: tests-NNN%20passing
  readme = readme.replace(
    /tests-\d+%20passing/g,
    `tests-${testCount}%20passing`
  );

  // Update dev section: # NNN tests
  readme = readme.replace(
    /# \d+ tests/g,
    `# ${testCount} tests`
  );

  writeFileSync(readmePath, readme);
  console.log(`Tests: ${testCount} passing`);
  console.log(`  Updated: README.md badge + dev section`);
}

// 4. Run build to verify and inject version into dist
try {
  execSync('npm run build', { cwd: root, stdio: 'inherit' });
} catch {
  console.error('Build failed after version bump. Fix build errors.');
  process.exit(1);
}

console.log(`\nDone. Files updated:`);
console.log(`  manifest.json      ${newVersion}`);
console.log(`  package.json       ${newVersion}`);
console.log(`  STATUS.md          v${newVersion}`);
console.log(`  README.md          ${testCount} tests`);
console.log(`  dist/popup HTML    v${newVersion} (injected at build)`);
console.log(`  popup.ts runtime   reads from manifest (automatic)`);
