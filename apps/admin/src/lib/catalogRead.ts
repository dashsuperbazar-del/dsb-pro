// Screens that need the whole item catalog (Inventory, and Purchases which embeds it) used to download
// every item from the server on each visit: 11 sequential pages at 10k items. The device already holds the
// catalog the sync engine keeps current, so a screen reads that when - and only when - a full sync cycle
// has completed on this device. The device answer is display data: prices, stock and posting rules are
// still checked by the server when anything is posted.
export type CatalogRead<T> = { source: 'device' | 'server'; items: T[] };

export async function readCatalogForScreen<T>(input: {
  /** Resolves null while the device catalog could still be partial (no completed sync yet). */
  device: () => Promise<T[] | null>;
  server: () => Promise<T[]>;
}): Promise<CatalogRead<T>> {
  try {
    const items = await input.device();
    if (items) return { source: 'device', items };
  } catch {
    // The device cache is not running or is closing; the server read below is authoritative.
  }
  return { source: 'server', items: await input.server() };
}

// Our own writes (new item, import, purchase) reach the server first and the device only through a later
// sync cycle. Until a cycle that STARTED after the write has completed, the device copy may lack it, so
// screens read the server instead. Module-level on purpose: it must survive leaving and re-entering a screen.
let dirtySince = 0;
export function markCatalogDirty(now = Date.now()): void {
  dirtySince = Math.max(dirtySince, now);
}
/** Tests only: start from a clean marker. */
export function resetCatalogDirtyForTests(): void {
  dirtySince = 0;
}
export function catalogDirtySince(): number {
  return dirtySince;
}
