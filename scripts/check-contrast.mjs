// WCAG AA contrast check for the D1 design tokens (apps/admin/src/tokens.css), light and dark.
// Text pairs need 4.5:1; large text / large money figures and non-text UI (focus ring, borders that
// carry meaning) need 3:1. Run: node scripts/check-contrast.mjs  (exit 1 on any failure).
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const css = readFileSync(join(root, 'apps', 'admin', 'src', 'tokens.css'), 'utf8');

function block(selector) {
  const start = css.indexOf(selector);
  if (start < 0) throw new Error(`check-contrast: ${selector} not found`);
  const open = css.indexOf('{', start);
  const close = css.indexOf('}', open);
  const out = {};
  for (const m of css.slice(open + 1, close).matchAll(/(--[\w-]+):\s*([^;]+);/g))
    out[m[1]] = m[2].trim();
  return out;
}
const light = block(':root {');
const darkTokens = block(":root[data-theme='dark'] {");
const dark = { ...light, ...darkTokens };
// The OS-dark block and the Appearance=dark block must stay identical.
if (JSON.stringify(block(":root:not([data-theme='light']) {")) !== JSON.stringify(darkTokens)) {
  console.error('check-contrast: FAIL — the two dark token blocks differ');
  process.exit(1);
}

function resolve(theme, value, depth = 0) {
  const m = /^var\((--[\w-]+)\)$/.exec(value);
  if (!m) return value;
  if (depth > 10 || !(m[1] in theme)) throw new Error(`unresolved ${value}`);
  return resolve(theme, theme[m[1]], depth + 1);
}
function rgb(hex) {
  const h = hex.replace('#', '');
  const full = h.length === 3 ? [...h].map((c) => c + c).join('') : h;
  return [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16));
}
function lum(hex) {
  const [r, g, b] = rgb(hex).map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function ratio(a, b) {
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}

// [foreground, background, minimum, what]
const T = 4.5;
const L = 3;
const pairs = [
  ['--text', '--bg', T, 'body text on page'],
  ['--text', '--surface', T, 'body text on card'],
  ['--text', '--surface-sunken', T, 'text on sunken / table header'],
  ['--text', '--surface-elevated', T, 'text on dialog'],
  ['--text-muted', '--bg', T, 'muted text on page'],
  ['--text-muted', '--surface', T, 'muted text on card'],
  ['--text-muted', '--surface-sunken', T, 'muted on table header'],
  ['--link', '--surface', T, 'link on card'],
  ['--link', '--bg', T, 'link on page'],
  ['--brand', '--surface', T, 'brand text (active nav, KPI) on card'],
  ['--brand', '--bg', T, 'brand text on page'],
  ['--on-brand', '--brand', T, 'primary button label'],
  ['--on-brand', '--brand-hover', T, 'primary button hover'],
  ['--on-brand', '--brand-active', T, 'primary button active'],
  ['--brand-subtle-text', '--brand-subtle', T, 'brand chip / active tab'],
  ['--header-text', '--header-bg', T, 'header title'],
  ['--header-muted', '--header-bg', T, 'header shop name'],
  ['--success', '--surface', T, 'success / money positive on card'],
  ['--success', '--success-bg', T, 'success chip'],
  ['--warning', '--surface', T, 'warning text on card'],
  ['--warning', '--warning-bg', T, 'warning chip / banner'],
  ['--danger', '--surface', T, 'danger / money negative on card'],
  ['--danger', '--danger-bg', T, 'danger chip / banner'],
  ['--danger', '--bg', T, 'error text on page'],
  ['--info', '--surface', T, 'info text on card'],
  ['--info', '--info-bg', T, 'info chip / banner'],
  ['--text', '--brand-subtle', T, 'text on selected row'],
  ['--brand', '--surface', L, 'large money figure (brand)'],
  ['--focus-ring', '--surface', L, 'focus ring vs card (non-text)'],
  ['--focus-ring', '--bg', L, 'focus ring vs page (non-text)'],
  ['--border-strong', '--surface', 1.5, 'input border (decorative; labels carry meaning)'],
];

let failed = 0;
for (const [name, theme] of [
  ['light', light],
  ['dark', dark],
]) {
  console.log(`\n${name}`);
  for (const [fg, bg, min, what] of pairs) {
    const r = ratio(resolve(theme, theme[fg]), resolve(theme, theme[bg]));
    const ok = r >= min;
    if (!ok) failed++;
    console.log(
      `  ${ok ? 'PASS' : 'FAIL'} ${r.toFixed(2).padStart(5)}:1 (min ${min})  ${fg} on ${bg} — ${what}`,
    );
  }
}
console.log(failed ? `\ncheck-contrast: FAIL (${failed})` : '\ncheck-contrast: PASS');
process.exit(failed ? 1 : 0);
