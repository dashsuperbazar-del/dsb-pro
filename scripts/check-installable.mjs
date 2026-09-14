// Installability gate for apps/admin (plan §12, as amended by §19.6).
//
// §12 asks for "Lighthouse PWA >= 90". That category no longer exists —
// Lighthouse removed it in v12 and is now at 13.x. The requirement's intent was
// that the app is genuinely installable and works offline. Offline behaviour is
// already proven far more rigorously by the Phase 5 chaos suite. What was left
// unchecked was installability, and it was in fact broken: the manifest shipped
// with no icons at all from Phase 0 until this gate was added.
//
// The first version of this gate only checked that an icon entry existed and
// pointed at a non-empty file. That was too weak to call a regression gate — a
// 16x16 placeholder, or a .png that was secretly an SVG, would have sailed
// through. It now reads the actual image headers and compares them against what
// the manifest claims.
//
// Deterministic and browser-free, so unlike a scored audit it cannot flake on a
// shared runner.
import { readFileSync, existsSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'apps', 'admin', 'dist');
const failures = [];
const notes = [];

const fail = (message) => failures.push(message);
const check = (condition, message) => { if (!condition) fail(message); };

if (!existsSync(dist)) {
  console.error(`check-installable: ${dist} does not exist — run the build first.`);
  process.exit(1);
}

/** Real pixel dimensions from the file itself, never from the manifest's claim. */
function realDimensions(buffer, declaredType) {
  // PNG: 8-byte signature, then IHDR with width/height as big-endian uint32.
  if (buffer.length >= 24 && buffer.subarray(0, 8).toString('hex') === '89504e470d0a1a0a') {
    return { kind: 'png', width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
  }
  const head = buffer.subarray(0, 2048).toString('utf8');
  if (/<svg[\s>]/i.test(head)) {
    // An SVG is resolution-independent; record that rather than a pixel size.
    return { kind: 'svg', width: Infinity, height: Infinity };
  }
  if (buffer.subarray(0, 3).toString('hex') === 'ffd8ff') return { kind: 'jpeg', width: 0, height: 0 };
  if (buffer.subarray(0, 4).toString('utf8') === 'RIFF') return { kind: 'webp', width: 0, height: 0 };
  return { kind: `unknown (declared ${declaredType ?? 'nothing'})`, width: 0, height: 0 };
}

const EXPECTED_KIND = { 'image/png': 'png', 'image/svg+xml': 'svg', 'image/jpeg': 'jpeg', 'image/webp': 'webp' };

// --- manifest ---------------------------------------------------------------
const manifestPath = join(dist, 'manifest.webmanifest');
check(existsSync(manifestPath), 'dist/manifest.webmanifest is missing');

let manifest;
if (existsSync(manifestPath)) {
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch (error) {
    fail(`manifest.webmanifest is not valid JSON: ${error.message}`);
  }
}

if (manifest) {
  check(!!manifest.name, 'manifest is missing "name"');
  check(!!manifest.short_name, 'manifest is missing "short_name"');
  check(!!manifest.start_url, 'manifest is missing "start_url"');
  check(
    ['standalone', 'fullscreen', 'minimal-ui'].includes(manifest.display),
    `manifest "display" must be standalone, fullscreen or minimal-ui (got ${JSON.stringify(manifest.display)})`
  );

  const icons = Array.isArray(manifest.icons) ? manifest.icons : [];
  check(icons.length > 0, 'manifest has no icons — a browser will refuse to install the app');

  let largestAny = 0;
  let hasMaskable = false;
  let has192 = false;

  for (const icon of icons) {
    const label = icon.src ?? '(entry with no src)';
    if (!icon.src) { fail('an icon entry has no "src"'); continue; }

    const iconPath = join(dist, icon.src.replace(/^\.?\//, ''));
    if (!existsSync(iconPath)) { fail(`icon "${label}" is declared but not present in dist`); continue; }
    if (statSync(iconPath).size === 0) { fail(`icon "${label}" is an empty file`); continue; }

    const buffer = readFileSync(iconPath);
    const real = realDimensions(buffer, icon.type);

    // The declared MIME type must match what the bytes actually are.
    const expected = EXPECTED_KIND[icon.type];
    check(!!icon.type, `icon "${label}" declares no "type"`);
    if (expected) {
      check(real.kind === expected, `icon "${label}" declares ${icon.type} but its bytes are ${real.kind}`);
    } else if (icon.type) {
      fail(`icon "${label}" declares an unsupported type "${icon.type}"`);
    }

    const purpose = (icon.purpose ?? 'any').split(/\s+/);
    if (purpose.includes('maskable')) hasMaskable = true;

    if (real.kind === 'svg') {
      check(icon.sizes === 'any', `svg icon "${label}" should declare sizes "any" (got ${JSON.stringify(icon.sizes)})`);
      // Scalable, so it satisfies any size requirement it is used for.
      if (purpose.includes('any')) largestAny = Math.max(largestAny, 512);
      has192 = true;
    } else if (real.kind === 'png') {
      check(real.width === real.height, `icon "${label}" is ${real.width}x${real.height}; icons must be square`);
      // The declared sizes must be true, not aspirational.
      const declared = String(icon.sizes ?? '').match(/^(\d+)x(\d+)$/);
      check(!!declared, `icon "${label}" must declare sizes as WxH (got ${JSON.stringify(icon.sizes)})`);
      if (declared) {
        check(
          Number(declared[1]) === real.width && Number(declared[2]) === real.height,
          `icon "${label}" declares ${icon.sizes} but the file is ${real.width}x${real.height}`
        );
      }
      if (purpose.includes('any')) largestAny = Math.max(largestAny, real.width);
      if (real.width >= 192) has192 = true;
      if (purpose.includes('maskable')) {
        check(real.width >= 512, `maskable icon "${label}" is ${real.width}px; 512 or larger is expected`);
      }
    } else {
      fail(`icon "${label}" is not a usable image (detected ${real.kind})`);
    }
  }

  if (icons.length > 0) {
    check(has192, 'no icon is 192x192 or larger — browsers require one to offer installation');
    check(largestAny >= 512, 'no "any"-purpose icon is 512x512 or larger');
    // A hard failure, not a note. The previous version only warned here, which
    // meant this file claimed to guarantee a maskable icon while quietly
    // passing without one — the gate did not enforce what it advertised.
    check(hasMaskable, 'no maskable icon declared — the home-screen icon will be letterboxed on Android');
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

for (const note of notes) console.warn(`check-installable: note — ${note}`);

if (failures.length > 0) {
  console.error('check-installable: FAIL');
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}

console.log('check-installable: PASS');
console.log('  manifest fields, icon bytes, declared sizes, service worker and document links all verified.');
