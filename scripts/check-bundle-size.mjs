// Bundle ceiling for apps/admin (plan §12: "admin bundle < 250KB gz").
//
// The shop runs on throttled mobile data, so this is a real constraint rather
// than hygiene. Measured as the gzipped total of every emitted JS and CSS
// asset, which is what a first visit actually downloads.
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { dirname, join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const assets = join(root, 'apps', 'admin', 'dist', 'assets');
const LIMIT = 250 * 1024; // 250 KiB, per plan §12

if (!existsSync(assets)) {
  console.error(`check-bundle-size: ${assets} does not exist — run the build first.`);
  process.exit(1);
}

let total = 0;
const rows = [];
for (const name of readdirSync(assets)) {
  if (!['.js', '.css'].includes(extname(name))) continue;
  const size = gzipSync(readFileSync(join(assets, name))).length;
  rows.push([name, size]);
  total += size;
}

rows.sort((a, b) => b[1] - a[1]);
for (const [name, size] of rows) {
  console.log(`  ${String(Math.round(size / 1024)).padStart(5)} KB gz  ${name}`);
}

const pct = Math.round((total / LIMIT) * 100);
console.log(`\ntotal ${Math.round(total / 1024)} KB gz of ${LIMIT / 1024} KB ceiling (${pct}%)`);

if (total > LIMIT) {
  console.error('check-bundle-size: FAIL — the admin bundle exceeds the plan §12 ceiling.');
  process.exit(1);
}

console.log('check-bundle-size: PASS');
