// Installability gate for apps/admin (plan §12, as amended by §19.6).
//
// §12 asks for "Lighthouse PWA >= 90". That category no longer exists —
// Lighthouse removed the PWA category in v12, and the current release is 13.x.
// The requirement's intent was that the app is genuinely installable and works
// offline. Offline behaviour is already proven far more rigorously than
// Lighthouse ever did, by the Phase 5 chaos suite. What was left unchecked was
// installability, and it was in fact broken: the manifest shipped with no
// icons at all from Phase 0 until this gate was added, so the app could not be
// installed on any device.
//
// This check is deterministic and needs no browser, so unlike a scored audit it
// cannot flake on a shared runner.
import { readFileSync, existsSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'apps', 'admin', 'dist');
const failures = [];

function check(condition, message) {
  if (!condition) failures.push(message);
}

if (!existsSync(dist)) {
  console.error(`check-installable: ${dist} does not exist — run the build first.`);
  process.exit(1);
}

// --- manifest ---------------------------------------------------------------
const manifestPath = join(dist, 'manifest.webmanifest');
check(existsSync(manifestPath), 'dist/manifest.webmanifest is missing');

if (existsSync(manifestPath)) {
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch (error) {
    failures.push(`manifest.webmanifest is not valid JSON: ${error.message}`);
  }

  if (manifest) {
    check(!!manifest.name, 'manifest is missing "name"');
    check(!!manifest.short_name, 'manifest is missing "short_name"');
    check(!!manifest.start_url, 'manifest is missing "start_url"');
    check(
      ['standalone', 'fullscreen', 'minimal-ui'].includes(manifest.display),
      `manifest "display" must be standalone, fullscreen or minimal-ui (got ${JSON.stringify(manifest.display)})`
    );
    check(
      Array.isArray(manifest.icons) && manifest.icons.length > 0,
      'manifest has no icons — a browser will refuse to install the app'
    );

    for (const icon of manifest.icons ?? []) {
      check(!!icon.src, 'an icon entry has no "src"');
      if (!icon.src) continue;
      const iconPath = join(dist, icon.src.replace(/^\.?\//, ''));
      check(existsSync(iconPath), `icon "${icon.src}" is declared but not present in dist`);
      if (existsSync(iconPath)) {
        check(statSync(iconPath).size > 0, `icon "${icon.src}" is an empty file`);
      }
    }
  }
}

// --- service worker ---------------------------------------------------------
const swPath = join(dist, 'sw.js');
check(existsSync(swPath), 'dist/sw.js is missing');
if (existsSync(swPath)) {
  check(statSync(swPath).size > 500, 'dist/sw.js is implausibly small to be a real service worker');
}

// --- the page actually references the manifest ------------------------------
const indexPath = join(dist, 'index.html');
check(existsSync(indexPath), 'dist/index.html is missing');
if (existsSync(indexPath)) {
  const html = readFileSync(indexPath, 'utf8');
  check(/rel=["']manifest["']/.test(html), 'index.html does not link the web manifest');
  check(/rel=["']icon["']/.test(html), 'index.html declares no favicon');
}

if (failures.length > 0) {
  console.error('check-installable: FAIL');
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}

console.log('check-installable: PASS — manifest, icons, service worker and links are all present.');
