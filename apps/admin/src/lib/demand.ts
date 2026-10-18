// I08 demand: net units sold per week (sales minus confirmed returns), in base units. Quantities are summed
// as integer millionths (DB numeric(18,6)) so the totals are exact; display only, nothing is stored.
export type Movement = { businessDate: string; baseQty: number };
export type DemandWeek = { start: string; end: string; netMicro: number };

const DAY = 86_400_000;
const parse = (d: string) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) throw new Error('Invalid date.');
  const t = Date.parse(`${d}T00:00:00Z`);
  if (!Number.isFinite(t)) throw new Error('Invalid date.');
  return t;
};
const iso = (t: number) => new Date(t).toISOString().slice(0, 10);
const micro = (q: number) => Math.round(q * 1_000_000);

export const sinceDate = (today: string, weeks: number) =>
  iso(parse(today) - (weeks * 7 - 1) * DAY);

export function weeklyDemand(
  data: { sales: Movement[]; returns: Movement[] },
  today: string,
  weeks: number,
): DemandWeek[] {
  const end = parse(today);
  const first = end - (weeks * 7 - 1) * DAY;
  const out: DemandWeek[] = Array.from({ length: weeks }, (_, i) => ({
    start: iso(first + i * 7 * DAY),
    end: iso(first + (i * 7 + 6) * DAY),
    netMicro: 0,
  }));
  const add = (m: Movement, sign: 1 | -1) => {
    const t = parse(m.businessDate);
    if (t < first || t > end) return;
    out[Math.floor((t - first) / (7 * DAY))]!.netMicro += sign * micro(m.baseQty);
  };
  data.sales.forEach((m) => add(m, 1));
  data.returns.forEach((m) => add(m, -1));
  return out;
}

export function formatQty(m: number) {
  const sign = m < 0 ? '-' : '';
  const a = Math.abs(m);
  const frac = String(a % 1_000_000)
    .padStart(6, '0')
    .replace(/0+$/, '');
  return `${sign}${Math.floor(a / 1_000_000)}${frac ? `.${frac}` : ''}`;
}
