import type {
  Item,
  Party,
  PurchaseRecord,
  PurchaseHistoryLine,
  PurchaseBalance,
} from '@dsb-pro/adapters';
import { canonicalQuantity } from '@dsb-pro/core';
export type PurchaseDraftLine = {
  item: Item;
  unitLevel: 1 | 2 | 3;
  qty: string;
  unitPricePaise: number;
};
export function repeatPurchase(
  bill: PurchaseRecord,
  lines: PurchaseHistoryLine[],
  items: Item[],
): PurchaseDraftLine[] {
  if (bill.status !== 'POSTED') throw new Error('A void purchase cannot be repeated.');
  if (!lines.length) throw new Error('This purchase has no items.');
  return lines.map((line) => {
    const item = items.find((i) => i.id === line.item_id);
    if (!item)
      throw new Error(`${line.item_name_snapshot} is unavailable. Create a new purchase manually.`);
    const unit =
      line.unit_level === 1 ? item.unit1 : line.unit_level === 2 ? item.unit2 : item.unit3;
    if (
      unit !== line.unit_name_snapshot ||
      Number(item.conv1 ?? 1) !== Number(line.conv1_snapshot ?? 1) ||
      Number(item.conv2 ?? 1) !== Number(line.conv2_snapshot ?? 1)
    )
      throw new Error(`${item.name}: units changed since that bill. Review a new item manually.`);
    const price = Number(line.unit_price_paise);
    if (!Number.isSafeInteger(price) || price < 0)
      throw new Error('Purchase cost is outside the supported range.');
    return {
      item,
      unitLevel: line.unit_level,
      qty: canonicalQuantity(line.qty),
      unitPricePaise: price,
    };
  });
}
export function purchaseStatus(
  bill: PurchaseRecord,
  balance?: Pick<
    PurchaseBalance,
    'outstanding_paise' | 'allocated_paise' | 'returned_paise'
  > | null,
) {
  if (bill.status === 'VOID') return 'Voided';
  if (!balance) return 'Unavailable';
  if (BigInt(balance.outstanding_paise) === 0n) return 'Settled';
  return BigInt(balance.allocated_paise) > 0n || BigInt(balance.returned_paise) > 0n
    ? 'Partial'
    : 'Unpaid';
}
export function rankedPurchaseParties(parties: Party[], bills: PurchaseRecord[], today: string) {
  const score = (id: string) =>
    bills.filter(
      (b) =>
        b.party_id === id &&
        b.status === 'POSTED' &&
        b.business_date <= today &&
        Date.parse(today) - Date.parse(b.business_date) <= 90 * 86400000,
    );
  const frequent = [...parties]
    .filter((p) => score(p.id).length)
    .sort(
      (a, b) =>
        score(b.id).length - score(a.id).length ||
        score(b.id)[0].business_date.localeCompare(score(a.id)[0].business_date) ||
        a.name.localeCompare(b.name),
    )
    .slice(0, 6);
  return [
    ...frequent,
    ...parties
      .filter((p) => !frequent.some((f) => f.id === p.id))
      .sort((a, b) => a.name.localeCompare(b.name)),
  ];
}
