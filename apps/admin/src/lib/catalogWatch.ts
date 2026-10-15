// POS paints the device catalog once on entry. On a new device the first sync is still filling that
// catalog (one page is 1,000 items), so a screen opened mid-sync would keep the partial list until a
// reload. This watcher re-reads the device catalog whenever it grows. Display only, and additive only:
// it can add items the screen has not shown but never replaces, edits or removes one, so it cannot
// overwrite fresher data or bring back an item that was archived while the screen was open. The catalog
// never decides a posting; prices and stock are read and checked where they always were.
export function mergeCatalog<T extends { id: string; name: string }>(
  shown: T[],
  fresh: readonly T[],
): T[] {
  const known = new Set(shown.map((item) => item.id));
  const added = fresh.filter((item) => !known.has(item.id));
  if (!added.length) return shown; // same array: nothing to re-render
  return [...shown, ...added].sort((a, b) => a.name.localeCompare(b.name));
}

export function watchOfflineCatalog<T>(input: {
  count: () => Promise<number>;
  load: () => Promise<T[]>;
  onChange: (rows: T[]) => void;
  intervalMs?: number;
}): () => void {
  let stopped = false;
  let busy = false;
  let last = -1;
  async function look() {
    if (stopped || busy) return;
    busy = true;
    try {
      const n = await input.count();
      if (stopped) return;
      // The first look always loads once (the screen may have painted a smaller catalog than the
      // device holds by now); after that only growth reloads.
      if (n > last) {
        const rows = await input.load();
        if (stopped) return;
        last = n;
        input.onChange(rows);
      } else last = n;
    } catch {
      // The cache may be closing or not ready; look again on the next tick.
    } finally {
      busy = false;
    }
  }
  const timer = setInterval(() => {
    if (typeof document === 'undefined' || document.visibilityState !== 'hidden') void look();
  }, input.intervalMs ?? 2000);
  void look();
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
