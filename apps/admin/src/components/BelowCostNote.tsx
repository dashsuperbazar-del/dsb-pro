import { listItemPurchasePrices, type Item } from '@dsb-pro/adapters';
import { useEffect, useState } from 'preact/hooks';
import { rupees } from '../lib/money';

// Old DSB price-anomaly warning: a sale price below the last purchase cost. A warning only: it never
// blocks, never changes the price, and is shown to owners/managers only (cashiers never see costs).
const costCache = new Map<string, Promise<number | null>>();

/** Last purchase cost per base unit (paise, may be fractional), or null when unknown. */
export function lastCostPerBase(shopId: string, itemId: string): Promise<number | null> {
  const key = `${shopId}:${itemId}`;
  let p = costCache.get(key);
  if (!p) {
    p = listItemPurchasePrices(shopId, itemId, 1).then(
      (rows) => {
        const r = rows[0];
        return r && r.baseQty > 0 ? r.lineTotalPaise / r.baseQty : null;
      },
      () => {
        costCache.delete(key);
        return null;
      },
    );
    costCache.set(key, p);
  }
  return p;
}

/** How many base units one unit at `level` holds. */
export function baseFactor(item: Item, level: 1 | 2 | 3): number {
  const c1 = item.unit2 ? Number(item.conv1 ?? 1) : 1;
  const c2 = item.unit3 ? Number(item.conv2 ?? 1) : 1;
  return level === 1 ? c1 * c2 : level === 2 ? c2 : 1;
}

export function BelowCostNote(props: {
  shopId: string;
  item: Item;
  unitLevel: 1 | 2 | 3;
  unitPricePaise: number;
}) {
  const { shopId, item } = props;
  const [cost, setCost] = useState<number | null>(null);
  useEffect(() => {
    if (!shopId || !item.id) return;
    let live = true;
    void lastCostPerBase(shopId, item.id).then((c) => live && setCost(c));
    return () => {
      live = false;
    };
  }, [shopId, item.id]);
  if (cost === null) return null;
  const unitCost = Math.round(cost * baseFactor(item, props.unitLevel));
  if (!(props.unitPricePaise < unitCost)) return null;
  return (
    <small class="typed-price alert-text" role="note" data-testid="below-cost">
      Below last purchase cost {rupees(unitCost)}
    </small>
  );
}
