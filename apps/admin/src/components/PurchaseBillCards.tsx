import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { Item, Party } from '@dsb-pro/adapters';
import {
  emptyCard,
  evaluateCard,
  isBlankCard,
  isUntouchedCard,
  withItem,
  switchCostMode,
  unitChoices,
  unitName,
  type BillCard,
} from '../lib/billCards';
import { boundedItemOptions } from '../lib/itemOptions';
import { deriveUnitCostFromTotal } from '../lib/purchaseCost';
import { matchItems, parseVoiceEntry, unitLevelFor } from '../lib/voiceEntry';
import { paiseToDecimal, rupees } from '../lib/money';
import { exactItemMatch, type NewItemFields } from '../lib/newItem';
import { learnedUnits } from '../lib/unitLearning';
import { CameraScanner } from './CameraScanner';
import { VoiceEntryButton } from './VoiceEntryButton';
import { CostDerivation } from './CostDerivation';
import { PriceHistory } from './PriceHistory';

const MATCH_LIMIT = 8;
const UNIT_LIST_ID = 'bill-card-units';
const OFFLINE_NOT_CREATED =
  "You're offline. The item was not created. Try again when you're online.";

// "+ Create" form of one card. clientId is kept for the life of the form, so a retry after a lost answer
// is refused by the database (unique client_id) instead of creating the item twice.
type NewItemForm = Required<Omit<NewItemFields, 'sku'>> & {
  clientId: string;
  error: string;
  busy: boolean;
};
// Same constraint attributes as the Inventory "Add item" form (required name and base unit, conversions
// are numbers of zero or more); the database checks the rest exactly as it does for that form.
const NEW_ITEM_FIELDS: {
  key: keyof Omit<NewItemFields, 'sku'>;
  label: string;
  required?: true;
  number?: true;
  units?: true;
}[] = [
  { key: 'name', label: 'New item name', required: true },
  { key: 'unit1', label: 'Base unit', required: true, units: true },
  { key: 'unit2', label: 'Second unit', units: true },
  { key: 'conv1', label: 'Second units per base unit', number: true },
  { key: 'unit3', label: 'Third unit', units: true },
  { key: 'conv2', label: 'Third units per second unit', number: true },
];

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
  /** Creates an item with the Add item adapter and refreshes the item list; absent = no "+ Create". */
  onCreateItem?: (fields: NewItemFields, clientId: string) => Promise<Item>;
}) {
  const { cards, items, disabled } = props;
  const latest = useRef(props);
  latest.current = props;
  const host = useRef<HTMLDivElement>(null);
  const [focusKey, setFocusKey] = useState('');
  const [pricesOpen, setPricesOpen] = useState<string[]>([]);
  const [newForms, setNewForms] = useState<Record<string, NewItemForm>>({});
  const creating = useRef(new Set<string>());
  const unitSuggestions = useMemo(() => learnedUnits(items), [items]);
  useEffect(() => {
    if (!focusKey) return;
    const [key, field] = focusKey.split('|');
    host.current
      ?.querySelector<HTMLInputElement>(
        `[data-card="${key}"] ${field ? `[data-field="${field}"]` : 'input'}`,
      )
      ?.focus();
    setFocusKey('');
  }, [focusKey, cards]);
  // A create form belongs to a card that still has no item; it goes away once the card gets one (a tap,
  // scan or voice result) or the card is removed, unless its create is still running.
  useEffect(() => {
    setNewForms((forms) => {
      const keep = Object.entries(forms).filter(
        ([key, f]) => f.busy || cards.some((c) => c.key === key && !c.item),
      );
      return keep.length === Object.keys(forms).length ? forms : Object.fromEntries(keep);
    });
  }, [cards]);

  function updateForm(key: string, change: Partial<NewItemForm>) {
    setNewForms((forms) =>
      forms[key] ? { ...forms, [key]: { ...forms[key]!, ...change } } : forms,
    );
  }
  function closeForm(key: string) {
    setNewForms((forms) => {
      const rest = { ...forms };
      delete rest[key];
      return rest;
    });
  }
  function openForm(card: BillCard) {
    setNewForms((forms) => ({
      ...forms,
      [card.key]: {
        clientId: crypto.randomUUID(),
        name: card.search.trim(),
        unit1: '',
        unit2: '',
        conv1: '',
        unit3: '',
        conv2: '',
        error: '',
        busy: false,
      },
    }));
    setFocusKey(`${card.key}|unit1`);
  }
  // The browser's own checks on the same attributes as the Add item form, plus a name and base unit that
  // are not only spaces. Returns the first problem, and focuses its field.
  function formProblem(key: string, form: NewItemForm): string {
    for (const f of NEW_ITEM_FIELDS) {
      const el = host.current?.querySelector<HTMLInputElement>(
        `[data-new-item="${key}"] [data-field="${f.key}"]`,
      );
      const blank = f.required && !form[f.key].trim();
      if (!blank && (!el || el.checkValidity())) continue;
      el?.focus();
      return blank
        ? `Enter the ${f.label.toLowerCase()}.`
        : `${f.label} must be a number, zero or more.`;
    }
    return '';
  }
  async function saveNew(key: string) {
    const form = newForms[key];
    const create = latest.current.onCreateItem;
    if (!form || !create || creating.current.has(key)) return;
    const problem = formProblem(key, form);
    if (problem) return updateForm(key, { error: problem });
    const existing = exactItemMatch(latest.current.items, form.name);
    if (existing)
      return updateForm(key, {
        error: `“${existing.name}” already exists. Choose it from the matches.`,
      });
    if (typeof navigator !== 'undefined' && navigator.onLine === false)
      return updateForm(key, { error: OFFLINE_NOT_CREATED });
    const fields: NewItemFields = {
      name: form.name,
      unit1: form.unit1,
      unit2: form.unit2,
      conv1: form.conv1,
      unit3: form.unit3,
      conv2: form.conv2,
    };
    creating.current.add(key);
    updateForm(key, { busy: true, error: '' });
    try {
      const item = await create(fields, form.clientId);
      closeForm(key);
      const now = latest.current.cards;
      const index = now.findIndex((c) => c.key === key);
      if (index >= 0 && !now[index]!.item) {
        // Selected with nothing carried over: the quantity and cost are entered for this item.
        patch(key, (c) => ({
          ...c,
          item,
          search: item.name,
          unitLevel: 1,
          qty: '',
          price: '',
          costMode: 'unit',
          unitHint: undefined,
        }));
        setFocusKey(`${key}|qty`);
        latest.current.onMessage(
          `Created ${item.name}. Enter the quantity and cost for item ${index + 1}.`,
        );
      } else
        latest.current.onMessage(
          `Created ${item.name}. It was not put on the bill because ${
            index < 0 ? 'that item card was removed' : `item ${index + 1} already has an item`
          }.`,
        );
    } catch (e) {
      updateForm(key, {
        busy: false,
        error:
          typeof navigator !== 'undefined' && navigator.onLine === false
            ? OFFLINE_NOT_CREATED
            : e instanceof Error
              ? e.message
              : String(e),
      });
    } finally {
      creating.current.delete(key);
    }
  }

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
    patch(key, (c) => withItem(c, item, unitLevel));
  }
  // Scan and voice results: fill the card they were started from while nothing is chosen or entered on it,
  // otherwise open a new card, so a result never overwrites an item already on the bill. Returns the
  // 1-based item number used, or null when that card was removed meanwhile (nothing is changed then).
  function place(key: string, fill: (c: BillCard) => BillCard): number | null {
    const { cards: now, onChange } = latest.current;
    const index = now.findIndex((c) => c.key === key);
    if (index < 0) return null;
    if (isUntouchedCard(now[index]!)) {
      onChange(now.map((c, i) => (i === index ? fill(c) : c)));
      return index + 1;
    }
    const card = fill(emptyCard());
    onChange([...now, card]);
    setFocusKey(card.key);
    return now.length + 1;
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
        const newForm = newForms[card.key];
        const canCreate = !!props.onCreateItem && !newForm && !exactItemMatch(items, card.search);
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
                  data-field="name"
                  value={card.search}
                  disabled={disabled}
                  onInput={(e) => {
                    const search = e.currentTarget.value;
                    // Typing over a chosen item drops it, with the quantity and cost entered for it.
                    patch(card.key, (c) =>
                      c.item && search !== c.item.name
                        ? {
                            ...c,
                            search,
                            item: null,
                            unitLevel: 1,
                            qty: '',
                            price: '',
                            costMode: 'unit',
                            unitHint: undefined,
                          }
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
                      const at = place(card.key, (c) => withItem(c, hit.item, hit.unitLevel));
                      if (at === null) return;
                      props.onMessage(
                        `Scanned ${hit.item.name} into item ${at}. Enter the quantity and cost.`,
                      );
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
                    const at = place(card.key, (c) => ({
                      ...c,
                      item: null,
                      search: v.name,
                      unitLevel: 1,
                    }));
                    if (at === null) return;
                    props.onMessage(
                      hits.length
                        ? `Heard “${text}”: ${hits.length} items match. Tap the right one in item ${at}.`
                        : `Heard “${text}”: no item matches “${v.name}”.`,
                    );
                    return;
                  }
                  const hit = hits[0]!;
                  const at = place(card.key, (c) => ({
                    ...withItem(c, hit, unitLevelFor(hit, v.unitWord) ?? 1),
                    costMode: 'unit',
                    unitHint: undefined,
                    qty: v.qty ?? '',
                    price: v.rate ?? '',
                  }));
                  if (at === null) return;
                  props.onMessage(
                    `Heard “${text}”. Check item ${at}: ${hit.name}, the unit, quantity and rate.`,
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
                {canCreate && (
                  <button
                    type="button"
                    class="bill-card-create"
                    disabled={disabled}
                    onClick={() => openForm(card)}
                  >
                    + Create “{card.search.trim()}”
                  </button>
                )}
              </div>
            )}
            {newForm && !item && (
              <div
                class="bill-card-new"
                role="group"
                aria-label={`New item for item ${n}`}
                data-new-item={card.key}
              >
                <small class="muted">New item, saved to your items list</small>
                {NEW_ITEM_FIELDS.map((f) => (
                  <label key={f.key} class={f.key === 'name' ? 'bill-card-new-name' : undefined}>
                    {f.label}
                    {f.required ? '' : ' (optional)'}
                    <input
                      aria-label={`Item ${n} ${f.label.toLowerCase()}`}
                      data-field={f.key}
                      autocomplete="off"
                      required={f.required}
                      list={f.units ? UNIT_LIST_ID : undefined}
                      {...(f.number
                        ? { type: 'number', inputMode: 'decimal', min: '0', step: 'any' }
                        : {})}
                      placeholder={
                        f.key === 'unit1'
                          ? 'e.g. ctn'
                          : f.key === 'unit2'
                            ? 'e.g. pkt'
                            : f.number
                              ? 'e.g. 12'
                              : undefined
                      }
                      value={newForm[f.key]}
                      disabled={disabled || newForm.busy}
                      onInput={(e) => {
                        const value = e.currentTarget.value;
                        updateForm(card.key, { [f.key]: value });
                      }}
                    />
                  </label>
                ))}
                {newForm.error && (
                  <p role="alert" class="bill-card-new-error">
                    {newForm.error}
                  </p>
                )}
                <div class="bill-card-new-actions">
                  <button
                    type="button"
                    class="primary"
                    disabled={disabled || newForm.busy}
                    onClick={() => void saveNew(card.key)}
                  >
                    {newForm.busy ? 'Saving…' : 'Save item'}
                  </button>
                  <button
                    type="button"
                    disabled={disabled || newForm.busy}
                    onClick={() => closeForm(card.key)}
                  >
                    Cancel
                  </button>
                </div>
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
                    onClick={() =>
                      patch(card.key, (c) => (c.item ? withItem(c, c.item, u.level) : c))
                    }
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
                  data-field="qty"
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
                  data-field="price"
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
      {props.onCreateItem && (
        <datalist id={UNIT_LIST_ID}>
          {unitSuggestions.map((u) => (
            <option key={u} value={u} />
          ))}
        </datalist>
      )}
      {cards.length > 0 && (
        <button type="button" class="bill-add-bottom" disabled={disabled} onClick={addCard}>
          + Add another item
        </button>
      )}
    </div>
  );
}
