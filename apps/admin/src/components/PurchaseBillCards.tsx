import { useEffect, useRef, useState } from 'preact/hooks';
import type { Item, Party } from '@dsb-pro/adapters';
import {
  emptyCard,
  evaluateCard,
  isBlankCard,
  switchCostMode,
  unitChoices,
  unitName,
  type BillCard,
} from '../lib/billCards';
import { boundedItemOptions } from '../lib/itemOptions';
import { deriveUnitCostFromTotal } from '../lib/purchaseCost';
import { matchItems, parseVoiceEntry, unitLevelFor } from '../lib/voiceEntry';
import { paiseToDecimal, rupees } from '../lib/money';
import { CameraScanner } from './CameraScanner';
import { VoiceEntryButton } from './VoiceEntryButton';
import { CostDerivation } from './CostDerivation';
import { PriceHistory } from './PriceHistory';

const MATCH_LIMIT = 8;

// Old DSB bill entry: an ITEMS header (Repeat, + Add item), recent supplier items to tap, then one card per
// item ("ITEM 1", "ITEM 2" …), all editable at once. Cards only hold what was typed; the screen derives the
// posted lines from them (lib/billCards), so this component never decides money.
export function PurchaseBillCards(props: {
  cards: BillCard[];
  items: Item[];
  onChange: (next: BillCard[]) => void;
  disabled?: boolean;
  shopId: string;
  parties: Party[];
  canSeePrices: boolean;
  onMessage: (message: string) => void;
  /** Barcode lookup for the card's camera scan; null when no item has that barcode. */
  findBarcode?: (code: string) => Promise<{ item: Item; unitLevel: 1 | 2 | 3 } | null>;
  onRepeat?: () => void;
  recent?: { key: string; label: string; onAdd: () => void }[];
}) {
  const { cards, items, disabled } = props;
  const latest = useRef(props);
  latest.current = props;
  const host = useRef<HTMLDivElement>(null);
  const [focusKey, setFocusKey] = useState('');
  const [pricesOpen, setPricesOpen] = useState<string[]>([]);
  useEffect(() => {
    if (!focusKey) return;
    host.current?.querySelector<HTMLInputElement>(`[data-card="${focusKey}"] input`)?.focus();
    setFocusKey('');
  }, [focusKey, cards]);

  // Always applies to the newest card list, so a slow scan or voice result cannot undo later typing.
  function patch(key: string, change: (c: BillCard) => BillCard) {
    const { cards: now, onChange } = latest.current;
    onChange(now.map((c) => (c.key === key ? change(c) : c)));
  }
  function addCard() {
    const card = emptyCard();
    props.onChange([...cards, card]);
    setFocusKey(card.key);
  }
  function remove(card: BillCard, n: number) {
    if (
      !isBlankCard(card) &&
      !confirm(`Remove item ${n}${card.item ? ` (${card.item.name})` : ''} from this bill?`)
    )
      return;
    props.onChange(cards.filter((c) => c.key !== card.key));
  }
  function choose(key: string, item: Item, unitLevel: 1 | 2 | 3 = 1) {
    patch(key, (c) => ({ ...c, item, search: item.name, unitLevel }));
  }

  return (
    <div class="bill-items" ref={host}>
      <div class="bill-items-head">
        <h3>Items</h3>
        <div class="bill-items-actions">
          {props.onRepeat && (
            <button type="button" disabled={disabled} onClick={props.onRepeat}>
              ↺ Repeat last bill
            </button>
          )}
          <button type="button" disabled={disabled} onClick={addCard}>
            + Add item
          </button>
        </div>
      </div>
      {!!props.recent?.length && (
        <div class="shortcut-chips" aria-label="Recent supplier items">
          <small class="muted">Recent items from this supplier, tap to add</small>
          {props.recent.map((r) => (
            <button type="button" key={r.key} disabled={disabled} onClick={r.onAdd}>
              {r.label}
            </button>
          ))}
        </div>
      )}
      {cards.length === 0 && <p class="muted">No items yet. Press “+ Add item”.</p>}
      {cards.map((card, i) => {
        const n = i + 1;
        const item = card.item;
        const result = evaluateCard(card);
        const searching = card.search.trim() && !item;
        const picker = searching ? boundedItemOptions(items, card.search, '', MATCH_LIMIT) : null;
        const typedTotal = card.costMode === 'total' && card.qty.trim() && card.price.trim();
        const priceLabel = card.costMode === 'total' ? 'total ₹' : 'rate ₹';
        return (
          <section class="bill-card" key={card.key} data-card={card.key} aria-label={`Item ${n}`}>
            <div class="bill-card-head">
              <strong>ITEM {n}</strong>
              <button
                type="button"
                class="bill-card-remove"
                aria-label={`Remove item ${n}`}
                disabled={disabled}
                onClick={() => remove(card, n)}
              >
                ×
              </button>
            </div>
            <div class="bill-card-find">
              <label>
                Item name
                <input
                  aria-label={`Item ${n} name`}
                  placeholder="Type to search"
                  autocomplete="off"
                  value={card.search}
                  disabled={disabled}
                  onInput={(e) => {
                    const search = e.currentTarget.value;
                    patch(card.key, (c) =>
                      c.item && search !== c.item.name
                        ? { ...c, search, item: null, unitLevel: 1 }
                        : { ...c, search },
                    );
                  }}
                />
              </label>
              <CameraScanner
                disabled={disabled || !props.findBarcode}
                onCode={(code) => {
                  void (async () => {
                    try {
                      const hit = await latest.current.findBarcode?.(code);
                      if (!hit) {
                        props.onMessage(`Barcode ${code} is not linked to any item.`);
                        return;
                      }
                      choose(card.key, hit.item, hit.unitLevel);
                      props.onMessage(`Scanned ${hit.item.name}. Enter the quantity and cost.`);
                    } catch (e) {
                      props.onMessage(`Barcode lookup failed: ${String(e)}`);
                    }
                  })();
                }}
              />
              <VoiceEntryButton
                name={`Speak item ${n}`}
                disabled={disabled}
                onText={(text) => {
                  const v = parseVoiceEntry(text);
                  if (!v) {
                    props.onMessage(
                      `Did not understand “${text}”. Say the item name, then the quantity.`,
                    );
                    return;
                  }
                  const hits = matchItems(latest.current.items, v.name);
                  if (hits.length !== 1) {
                    patch(card.key, (c) => ({ ...c, item: null, search: v.name, unitLevel: 1 }));
                    props.onMessage(
                      hits.length
                        ? `Heard “${text}”: ${hits.length} items match. Tap the right one in item ${n}.`
                        : `Heard “${text}”: no item matches “${v.name}”.`,
                    );
                    return;
                  }
                  const hit = hits[0]!;
                  patch(card.key, (c) => ({
                    ...c,
                    item: hit,
                    search: hit.name,
                    unitLevel: unitLevelFor(hit, v.unitWord) ?? 1,
                    costMode: 'unit',
                    qty: v.qty ?? '',
                    price: v.rate ?? '',
                  }));
                  props.onMessage(
                    `Heard “${text}”. Check item ${n}: ${hit.name}, the unit, quantity and rate.`,
                  );
                }}
              />
            </div>
            {picker && (
              <div class="bill-card-matches" role="group" aria-label={`Matches for item ${n}`}>
                {picker.options.map((m) => (
                  <button
                    type="button"
                    key={m.id}
                    disabled={disabled}
                    onClick={() => choose(card.key, m)}
                  >
                    {m.name}
                  </button>
                ))}
                {picker.matches === 0 && <small class="muted">No item matches.</small>}
                {picker.truncated && (
                  <small class="muted">
                    {picker.matches - picker.options.length} more, keep typing.
                  </small>
                )}
              </div>
            )}
            {item && (
              <div class="bill-card-units" role="group" aria-label={`Item ${n} purchased in`}>
                <small class="muted">Purchased in</small>
                {unitChoices(item).map((u) => (
                  <button
                    type="button"
                    key={u.level}
                    aria-pressed={card.unitLevel === u.level}
                    disabled={disabled}
                    onClick={() => patch(card.key, (c) => ({ ...c, unitLevel: u.level }))}
                  >
                    {u.name}
                  </button>
                ))}
              </div>
            )}
            <div class="bill-card-figures">
              <label>
                Qty{item ? ` (${unitName(item, card.unitLevel)})` : ''}
                <input
                  aria-label={`Item ${n} quantity`}
                  type="number"
                  inputMode="decimal"
                  min="0.000001"
                  step="any"
                  placeholder="Qty"
                  value={card.qty}
                  disabled={disabled}
                  onInput={(e) => {
                    const qty = e.currentTarget.value;
                    patch(card.key, (c) => ({ ...c, qty }));
                  }}
                />
              </label>
              <label>
                {card.costMode === 'total' ? 'Total cost ₹' : 'Rate per unit ₹'}
                <input
                  aria-label={`Item ${n} ${priceLabel}`}
                  type="number"
                  inputMode="decimal"
                  min="0"
                  step="0.01"
                  placeholder={card.costMode === 'total' ? 'Total ₹' : 'Rate ₹'}
                  value={card.price}
                  disabled={disabled}
                  onInput={(e) => {
                    const price = e.currentTarget.value;
                    patch(card.key, (c) => ({ ...c, price }));
                  }}
                />
              </label>
            </div>
            <div class="bill-card-mode" role="group" aria-label={`Item ${n} cost entered as`}>
              <button
                type="button"
                aria-pressed={card.costMode === 'unit'}
                disabled={disabled}
                onClick={() => patch(card.key, (c) => switchCostMode(c, 'unit'))}
              >
                Per unit
              </button>
              <button
                type="button"
                aria-pressed={card.costMode === 'total'}
                disabled={disabled}
                onClick={() => patch(card.key, (c) => switchCostMode(c, 'total'))}
              >
                Total
              </button>
            </div>
            {typedTotal && (
              <CostDerivation
                derived={deriveUnitCostFromTotal(card.qty, card.price)}
                onUse={(unitPaise) =>
                  patch(card.key, (c) => ({
                    ...c,
                    costMode: 'unit',
                    price: paiseToDecimal(unitPaise),
                  }))
                }
              />
            )}
            <p class="bill-card-amount" aria-live="polite" data-testid={`item-${n}-amount`}>
              {result.kind === 'ok' ? (
                <strong>Amount {rupees(result.amountPaise)}</strong>
              ) : result.kind === 'problem' && !typedTotal ? (
                <span class="muted">{result.message}</span>
              ) : null}
            </p>
            {item && props.canSeePrices && (
              <div>
                <button
                  type="button"
                  class="link"
                  aria-expanded={pricesOpen.includes(card.key)}
                  onClick={() =>
                    setPricesOpen((open) =>
                      open.includes(card.key)
                        ? open.filter((k) => k !== card.key)
                        : [...open, card.key],
                    )
                  }
                >
                  Past prices for {item.name}
                </button>
                {pricesOpen.includes(card.key) && (
                  <PriceHistory
                    key={item.id}
                    shopId={props.shopId}
                    itemId={item.id}
                    baseUnit={item.unit3 || item.unit2 || item.unit1}
                    parties={props.parties}
                  />
                )}
              </div>
            )}
          </section>
        );
      })}
      {cards.length > 0 && (
        <button type="button" class="bill-add-bottom" disabled={disabled} onClick={addCard}>
          + Add another item
        </button>
      )}
    </div>
  );
}
