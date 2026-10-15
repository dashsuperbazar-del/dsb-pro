// POS paints the device catalog once on entry. On a new device the first sync is still filling that
// catalog (one page is 1,000 items), so a screen opened mid-sync would keep the partial list until a
// reload. This watcher reports the device catalog again whenever its size changes. Display only: the
// catalog never decides a posting, prices and stock are still read and checked where they always were.
export function mergeCatalog<T extends { id: string; name: string }>(
  shown: readonly T[],
  fresh: readonly T[],
): T[] {
  const merged = new Map(shown.map((item) => [item.id, item]));
  for (const item of fresh) merged.set(item.id, item);
  return [...merged.values()].sort((a, b) => a.name.localeCompare(b.name));
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
      if (last !== -1 && n !== last) {
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
