// Pickers used to render one <option> per item: 10,001 options at 10k items cost seconds on a phone. A picker
// shows at most this many matches; people narrow with the search box. The chosen item is always kept so a
// selection can never silently disappear from the list.
export const ITEM_OPTION_LIMIT = 50;

export function boundedItemOptions<T extends { id: string; name: string; sku?: string | null }>(
  items: readonly T[],
  search: string,
  selectedId: string,
  limit = ITEM_OPTION_LIMIT,
): { options: T[]; total: number; matches: number; truncated: boolean } {
  const needle = search.trim().toLowerCase();
  const matched = needle
    ? items.filter((i) => `${i.name} ${i.sku ?? ''}`.toLowerCase().includes(needle))
    : items;
  const options = matched.slice(0, limit);
  if (selectedId && !options.some((i) => i.id === selectedId)) {
    const chosen = items.find((i) => i.id === selectedId);
    if (chosen) options.unshift(chosen);
  }
  return {
    options,
    total: items.length,
    matches: matched.length,
    truncated: matched.length > limit,
  };
}
