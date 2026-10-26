// Bundle ceiling for apps/admin (plan §12: "admin bundle < 250KB gz"; raised to 260 KiB on 24 Oct 2026 for
// offline items + offline bill edit/void, decision recorded in docs/STATE.md, ratified by builder lead 24 Oct).
//
// The shop runs on throttled mobile data, so this is a real constraint rather
// than hygiene. D2 (26 Oct 2026): rarely used screens load on demand, so two
// numbers are gated (decision in docs/STATE.md):
//   initial — the gzipped JS/CSS that index.html loads before the first screen
//             (entry script, modulepreloads, stylesheets): <= 260 KiB, the
//             ratified ceiling, now applied to what blocks the first paint;
//   total   — every emitted JS/CSS file, which the service worker also
//             downloads once at install (dist/precache.json): <= 300 KiB.
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { dirname, join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const assets = join(root, 'apps', 'admin', 'dist', 'assets');
const LIMIT = 260 * 1024; // initial, 260 KiB (plan §12 was 250 KiB; see header)
const TOTAL_LIMIT = 300 * 1024; // every JS/CSS file (precached at install)

if (!existsSync(assets)) {
  console.error(`check-bundle-size: ${assets} does not exist — run the build first.`);
  process.exit(1);
}

const html = readFileSync(join(root, 'apps', 'admin', 'dist', 'index.html'), 'utf8');
const initialNames = new Set(
  [...html.matchAll(/(?:src|href)="[^"]*\/assets\/([^"/]+\.(?:js|css))"/g)].map((m) => m[1]),
);
if (![...initialNames].some((n) => n.endsWith('.js'))) {
  console.error('check-bundle-size: no entry script found in dist/index.html.');
  process.exit(1);
}

let total = 0;
let initial = 0;
const rows = [];
for (const name of readdirSync(assets)) {
  if (!['.js', '.css'].includes(extname(name))) continue;
  const size = gzipSync(readFileSync(join(assets, name))).length;
  rows.push([name, size]);
  total += size;
  if (initialNames.has(name)) initial += size;
}

rows.sort((a, b) => b[1] - a[1]);
for (const [name, size] of rows) {
  const tag = initialNames.has(name) ? 'initial' : 'on demand';
  console.log(`  ${String(Math.round(size / 1024)).padStart(5)} KB gz  ${tag.padEnd(9)}  ${name}`);
}

const kb = (n) => (n / 1024).toFixed(1);
console.log(
  `\ninitial ${kb(initial)} KB gz of ${LIMIT / 1024} KB ceiling (${Math.round((initial / LIMIT) * 100)}%)`,
);
console.log(
  `total   ${kb(total)} KB gz of ${TOTAL_LIMIT / 1024} KB ceiling (${Math.round((total / TOTAL_LIMIT) * 100)}%)`,
);

if (initial > LIMIT) {
  console.error('check-bundle-size: FAIL — the first-load bundle exceeds the plan §12 ceiling.');
  process.exit(1);
}
if (total > TOTAL_LIMIT) {
  console.error('check-bundle-size: FAIL — all JS/CSS together exceed the total ceiling.');
  process.exit(1);
}

console.log('check-bundle-size: PASS');
