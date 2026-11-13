/**
 * How a new purchase row takes its cost: "total" (the line total printed on the bill) or "unit" (rate per
 * unit). Owner, 13 Nov: Total by default. A tap on Per unit / Total is remembered on this device.
 */
export type CostMode = 'unit' | 'total';
const KEY = 'dsb:bill-cost-mode';

export function defaultCostMode(): CostMode {
  const pinned = (globalThis as { __dsbTestCostMode?: string }).__dsbTestCostMode;
  if (pinned === 'unit' || pinned === 'total') return pinned;
  try {
    return globalThis.localStorage?.getItem(KEY) === 'unit' ? 'unit' : 'total';
  } catch {
    return 'total';
  }
}

export function rememberCostMode(mode: CostMode): void {
  try {
    globalThis.localStorage?.setItem(KEY, mode);
  } catch {
    /* private mode: the default still applies */
  }
}
