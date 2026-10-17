import type { Item } from '@dsb-pro/adapters';

// I14: old DSB's unit autocomplete. The shop's own units, most used first, then the common ones it does not
// already use (case-insensitive). Suggestions only: any typed unit is still accepted.
export const COMMON_UNITS = [
  'ctn',
  'bag',
  'box',
  'Tin',
  'pcs',
  'pkt',
  'kg',
  'ltr',
  'dozen',
  'strip',
  'bundle',
  'roll',
];

export function learnedUnits(items: Pick<Item, 'unit1' | 'unit2' | 'unit3'>[]): string[] {
  const freq = new Map<string, { label: string; count: number }>();
  for (const it of items)
    for (const u of [it.unit1, it.unit2, it.unit3]) {
      const label = (u ?? '').trim();
      if (!label) continue;
      const key = label.toLowerCase();
      const hit = freq.get(key);
      if (hit) hit.count++;
      else freq.set(key, { label, count: 1 });
    }
  const learned = [...freq.values()]
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label))
    .map((x) => x.label);
  const seen = new Set(learned.map((u) => u.toLowerCase()));
  return [...learned, ...COMMON_UNITS.filter((u) => !seen.has(u.toLowerCase()))];
}
