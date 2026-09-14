// One-off developer tool: rasterises apps/admin/public/favicon.svg into the
// PNG icon set the web manifest needs.
//
// Deliberately NOT wired into the build and NOT a declared dependency: it runs
// by hand when the mark changes, and its outputs are committed. Adding sharp as
// a devDependency would pull a heavy native module into every install for a
// task performed roughly never.
//
// Run with a locally resolvable sharp, e.g.:
//   node scripts/gen-icons.mjs
// If sharp is not resolvable, install it transiently:
//   pnpm dlx sharp-cli --version   (or) npm i -D sharp && node scripts/gen-icons.mjs
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const publicDir = join(root, 'apps', 'admin', 'public');

function loadSharp() {
  try {
    return require('sharp');
  } catch {
    // pnpm keeps packages in a content-addressed store; find it there.
    const store = join(root, 'node_modules', '.pnpm');
    if (!existsSync(store)) throw new Error('sharp is not resolvable and node_modules/.pnpm is missing');
    const dir = readdirSync(store).filter((d) => d.startsWith('sharp@')).sort().pop();
    if (!dir) throw new Error('sharp is not resolvable; see the header of this file');
    return require(join(store, dir, 'node_modules', 'sharp'));
  }
}

const sharp = loadSharp();
const svg = readFileSync(join(publicDir, 'favicon.svg'));

// "any" icons: the mark on transparency, filling the canvas.
for (const size of [192, 512]) {
  const png = await sharp(svg, { density: 384 })
    .resize(size, size, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png({ compressionLevel: 9 })
    .toBuffer();
  writeFileSync(join(publicDir, `icon-${size}.png`), png);
  console.log(`wrote icon-${size}.png (${png.length} bytes)`);
}

// "maskable": the platform crops this to a circle, squircle or rounded square,
// so the mark must sit inside the central safe zone (~80% of the canvas) and
// the background must be opaque or the corners show through after cropping.
const MASKABLE = 512;
const inner = Math.round(MASKABLE * 0.56);
const glyph = await sharp(svg, { density: 384 })
  .resize(inner, inner, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
  .toBuffer();
const maskable = await sharp({
  create: { width: MASKABLE, height: MASKABLE, channels: 4, background: '#ffffff' },
})
  .composite([{ input: glyph, gravity: 'centre' }])
  .png({ compressionLevel: 9 })
  .toBuffer();
writeFileSync(join(publicDir, 'icon-maskable-512.png'), maskable);
console.log(`wrote icon-maskable-512.png (${maskable.length} bytes)`);
