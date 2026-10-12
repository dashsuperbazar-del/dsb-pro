import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import {
  addItemBarcode,
  createItem,
  createParty,
  getCurrentMembership,
  getDefaultShopId,
  getShopBusinessDate,
  importLegacyDsbMaster,
  listCurrentPrices,
  listItems,
  listParties,
  listStock,
  postPurchaseOutcome,
  replaceItemImage,
  setItemPrice,
  setItemMinStock,
  type Item,
  type ItemPrice,
  type Party,
  type StockRow,
  type PurchaseRequest,
} from '@dsb-pro/adapters';
import {
  buildLegacyDsbImportPlan,
  canonicalQuantity,
  parseRupeesToPaise,
  quantityTimesPaise,
  type LegacyDsbImportPlan,
} from '@dsb-pro/core';
import { compressItemImage } from '../lib/compressImage';
import { TaskTabs } from '../components/TaskTabs';
import { appRoute } from '../lib/paths';
import { clearPendingIntent, loadPendingIntent, savePendingIntent } from '../lib/pendingIntent';

const paise = (rupees: string) => parseRupeesToPaise(rupees || '0');

export function InventoryScreen() {
  type View = 'items' | 'purchase' | 'suppliers' | 'advanced';
  const initial = new URLSearchParams(window.location.search).get('view');
  const [view, setView] = useState<View>(
    initial === 'purchase' || initial === 'suppliers' || initial === 'advanced' ? initial : 'items',
  );
  const [itemSearch, setItemSearch] = useState('');
  const [items, setItems] = useState<Item[]>([]);
  const [parties, setParties] = useState<Party[]>([]);
  const [stock, setStock] = useState<StockRow[]>([]);
  const [shopId, setShopId] = useState('');
  const [tenantId, setTenantId] = useState('');
  const [businessDate, setBusinessDate] = useState('');
  const [selected, setSelected] = useState('');
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  const [pricesLoading, setPricesLoading] = useState(false);
  const [pricesFailed, setPricesFailed] = useState(false);
  const [purchaseLineItemId, setPurchaseLineItemId] = useState('');
  const [prices, setPrices] = useState<ItemPrice[]>([]);
  const [purchaseLineUnitLevel, setPurchaseLineUnitLevel] = useState<1 | 2 | 3>(1);
  const [purchaseLineQty, setPurchaseLineQty] = useState('');
  const [purchaseLinePrice, setPurchaseLinePrice] = useState('');
  const [purchaseCart, setPurchaseCart] = useState<
    { item: Item; unitLevel: 1 | 2 | 3; qty: string; unitPricePaise: number }[]
  >([]);
  const [purchaseClientId, setPurchaseClientId] = useState(() => crypto.randomUUID());
  // After a failure whose outcome is unknown (offline/server), the bill may already be posted. The
  // form stays frozen so a retry resends the SAME request id and payload; the server returns the
  // stored bill if it was committed (and refuses a changed payload).
  const [purchaseLocked, setPurchaseLocked] = useState(false);
  useEffect(() => {
    if (purchaseLocked) setView('purchase');
  }, [purchaseLocked]);
  const lockedPurchase = useRef<PurchaseRequest | null>(null);
  // Survives a reload: stored BEFORE the first send (V002 VF-005), so an unconfirmed purchase is
  // retried as the same request, never re-entered. Unreadable storage blocks new purchases.
  const pendingKey = (shop: string) => `dsb-pending-purchase:${shop}`;
  const [purchaseStorageBlocked, setPurchaseStorageBlocked] = useState('');
  useEffect(() => {
    if (!shopId) return;
    const saved = loadPendingIntent<PurchaseRequest>(pendingKey(shopId));
    if (!saved.ok) {
      setPurchaseStorageBlocked(saved.message);
    } else if (saved.value) {
      lockedPurchase.current = saved.value;
      setPurchaseLocked(true);
    }
  }, [shopId]);
  const [purchaseBusy, setPurchaseBusy] = useState(false);
  const [legacyPlan, setLegacyPlan] = useState<LegacyDsbImportPlan | null>(null);
  const [legacyFileName, setLegacyFileName] = useState('');
  const [legacyClientId, setLegacyClientId] = useState(() => crypto.randomUUID());
  const [legacyBusy, setLegacyBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const refreshGeneration = useRef(0);
  async function refresh() {
    const generation = ++refreshGeneration.current;
    const membership = await getCurrentMembership();
    if (!membership) throw new Error('No tenant membership.');
    const shop = await getDefaultShopId();
    if (generation !== refreshGeneration.current) return;
    setTenantId(membership.tenantId);
    setShopId(shop);
    const [i, p, s, d] = await Promise.all([
      listItems(),
      listParties(),
      listStock(shop),
      getShopBusinessDate(shop),
    ]);
    if (generation !== refreshGeneration.current) return;
    setItems(i);
    setParties(p);
    setStock(s);
    setBusinessDate(d);
  }
  useEffect(() => {
    void refresh().catch((e) => setError(String(e)));
    return () => {
      refreshGeneration.current++;
    };
  }, []);
  useEffect(() => {
    if (!selected) {
      setPricesLoading(false);
      setPrices([]);
      return;
    }
    let cancelled = false;
    setPricesLoading(true);
    setPricesFailed(false);
    setPrices([]);
    void listCurrentPrices(selected)
      .then((value) => {
        if (!cancelled) {
          setPrices(value);
          setPricesLoading(false);
        }
      })
      .catch((e) => {
        if (!cancelled) {
          setError(String(e));
          setPricesFailed(true);
          setPricesLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [selected]);
  const selectedItem = items.find((i) => i.id === selected);
  const purchaseLineItem = items.find((i) => i.id === purchaseLineItemId);
  const selectedStock = useMemo(
    () => stock.find((s) => s.item_id === selected)?.qty_base ?? 0,
    [stock, selected],
  );
  const purchaseTotalPaise = useMemo(
    () => purchaseCart.reduce((sum, l) => sum + quantityTimesPaise(l.qty, l.unitPricePaise), 0),
    [purchaseCart],
  );
  const unitLabel = (item: Item, unitLevel: 1 | 2 | 3) =>
    unitLevel === 1
      ? item.unit1
      : unitLevel === 2
        ? item.unit2 || item.unit1
        : item.unit3 || item.unit2 || item.unit1;

  async function chooseLegacyBackup(ev: Event) {
    setError('');
    setMessage('');
    setLegacyPlan(null);
    setLegacyFileName('');
    const file = (ev.currentTarget as HTMLInputElement).files?.[0];
    if (!file) return;
    if (file.size > 5 * 1024 * 1024) {
      setError('DSB backup is too large to import from this screen.');
      return;
    }
    try {
      const parsed = JSON.parse(await file.text()) as unknown;
      const plan = buildLegacyDsbImportPlan(parsed);
      setLegacyPlan(plan);
      setLegacyFileName(file.name);
      setMessage(`Backup checked: ${plan.items.length} valid items are ready to import.`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }
  async function runLegacyImport() {
    if (legacyBusy || !legacyPlan || !shopId) return;
    const ok = window.confirm(
      `Import ${legacyPlan.items.length} items and their current stock into this empty DSB Pro shop? Old bills and invoices will NOT be imported.`,
    );
    if (!ok) return;
    setLegacyBusy(true);
    setError('');
    setMessage('');
    try {
      const summary = await importLegacyDsbMaster({
        shopId,
        plan: legacyPlan,
        clientId: legacyClientId,
      });
      setLegacyClientId(crypto.randomUUID());
      await refresh();
      setLegacyPlan(null);
      setLegacyFileName('');
      setMessage(
        `Import complete: ${summary.items} items, ${summary.parties} suppliers, ${summary.customers} customers and ${summary.stockRows} stock balances loaded.`,
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLegacyBusy(false);
    }
  }
  async function addItem(ev: Event) {
    ev.preventDefault();
    setError('');
    if (!tenantId) {
      setError('Shop data is still loading.');
      return;
    }
    const form = ev.currentTarget as HTMLFormElement;
    const f = new FormData(form);
    try {
      const item = await createItem({
        tenantId,
        name: String(f.get('name')),
        sku: String(f.get('sku') || '') || undefined,
        unit1: String(f.get('unit1')),
        unit2: String(f.get('unit2') || '') || undefined,
        unit3: String(f.get('unit3') || '') || undefined,
        conv1: f.get('conv1') ? Number(f.get('conv1')) : undefined,
        conv2: f.get('conv2') ? Number(f.get('conv2')) : undefined,
        clientId: crypto.randomUUID(),
      });
      form.reset();
      await refresh();
      setMessage(`Created ${item.name}.`);
    } catch (e) {
      setError(String(e));
    }
  }
  async function addBarcode(ev: Event) {
    ev.preventDefault();
    if (!tenantId) {
      setError('Shop data is still loading.');
      return;
    }
    if (!selectedItem) return;
    const form = ev.currentTarget as HTMLFormElement;
    const f = new FormData(form);
    try {
      await addItemBarcode({
        tenantId,
        itemId: selectedItem.id,
        barcode: String(f.get('barcode')),
        unitLevel: Number(f.get('unitLevel')) as 1 | 2 | 3,
        clientId: crypto.randomUUID(),
      });
      form.reset();
      setMessage('Barcode linked to item.');
    } catch (e) {
      setError(String(e));
    }
  }
  async function addParty(ev: Event) {
    ev.preventDefault();
    setError('');
    if (!tenantId) {
      setError('Shop data is still loading.');
      return;
    }
    const form = ev.currentTarget as HTMLFormElement;
    const f = new FormData(form);
    try {
      const party = await createParty({
        tenantId,
        name: String(f.get('name')),
        phone: String(f.get('phone') || '') || undefined,
        gstin: String(f.get('gstin') || '') || undefined,
        clientId: crypto.randomUUID(),
      });
      form.reset();
      await refresh();
      setMessage(`Created supplier ${party.name}.`);
    } catch (e) {
      setError(String(e));
    }
  }
  function addPurchaseLine(ev: Event) {
    ev.preventDefault();
    setError('');
    const item = items.find((i) => i.id === purchaseLineItemId);
    let qty: string;
    const unitPricePaise = paise(purchaseLinePrice);
    if (!item) {
      setError('Choose an item for the purchase line.');
      return;
    }
    try {
      qty = canonicalQuantity(purchaseLineQty);
    } catch {
      setError('Enter a purchase quantity with at most 6 decimal places.');
      return;
    }
    if (!purchaseLinePrice.trim() || !(unitPricePaise >= 0)) {
      setError('Enter a unit cost.');
      return;
    }
    setPurchaseCart((v) => [...v, { item, unitLevel: purchaseLineUnitLevel, qty, unitPricePaise }]);
    setPurchaseLineItemId('');
    setPurchaseLineUnitLevel(1);
    setPurchaseLineQty('');
    setPurchaseLinePrice('');
  }
  function removePurchaseLine(index: number) {
    setPurchaseCart((v) => v.filter((_, i) => i !== index));
  }
  async function addPurchase(ev: Event) {
    ev.preventDefault();
    if (purchaseBusy) return;
    setError('');
    if (!shopId || !businessDate) {
      setError('Shop data is still loading.');
      return;
    }
    if (!purchaseCart.length && !(purchaseLocked && lockedPurchase.current)) {
      setError('Add at least one purchase line.');
      return;
    }
    const f = new FormData(ev.currentTarget as HTMLFormElement);
    const lineCount =
      purchaseLocked && lockedPurchase.current
        ? lockedPurchase.current.lines.length
        : purchaseCart.length;
    // A retry after an unknown outcome resends the frozen request byte for byte.
    const request = (purchaseLocked && lockedPurchase.current) || {
      shopId,
      partyId: String(f.get('partyId') || '') || undefined,
      billNo: String(f.get('billNo') || '') || undefined,
      businessDate: String(f.get('date')),
      discountPaise: paise(String(f.get('discount'))),
      extraChargesPaise: paise(String(f.get('extra'))),
      clientId: purchaseClientId,
      lines: purchaseCart.map((l) => ({
        itemId: l.item.id,
        unitLevel: l.unitLevel,
        qty: l.qty,
        unitPricePaise: l.unitPricePaise,
      })),
    };
    if (purchaseStorageBlocked) {
      setError(purchaseStorageBlocked);
      return;
    }
    const isRetry = Boolean(purchaseLocked && lockedPurchase.current);
    // Durable before dispatch, or not sent at all.
    try {
      savePendingIntent(pendingKey(request.shopId), request, { retry: isRetry });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return;
    }
    lockedPurchase.current = request;
    setPurchaseLocked(true);
    setPurchaseBusy(true);
    try {
      const outcome = await postPurchaseOutcome(request, isRetry);
      if (outcome.kind === 'unknown') {
        // May have committed: the form stays frozen and a retry resends this exact request.
        setError(
          `Not confirmed: ${outcome.message}. The bill is locked — retry sends the same bill and never posts it twice.`,
        );
        return;
      }
      lockedPurchase.current = null;
      setPurchaseLocked(false);
      clearPendingIntent(pendingKey(request.shopId), request.clientId);
      setPurchaseClientId(crypto.randomUUID());
      // Another window's unconfirmed purchase may still be stored: lock onto it next, same id (VF-009).
      const next = loadPendingIntent<PurchaseRequest>(pendingKey(request.shopId));
      const another = Boolean(next.ok && next.value);
      if (next.ok && next.value) {
        lockedPurchase.current = next.value;
        setPurchaseLocked(true);
      }
      const anotherNote = another
        ? ' Another unconfirmed purchase from this device is locked in the form now — retry it first; your cart is kept.'
        : '';
      if (outcome.kind === 'rejected') {
        // The database refused and rolled back: nothing posted; the cart stays for correction.
        setError(`Not posted: ${outcome.message}.${anotherNote}`);
        return;
      }
      // Only a purchase built from this cart (it carries the cart's id) clears the cart when it posts;
      // a restored entry from another window leaves the user's cart intact (Codex P2).
      if (request.clientId === purchaseClientId) setPurchaseCart([]);
      // Refresh before announcing, as before: the screen is settled when the message appears.
      let refreshNote = '';
      await refresh().catch((e) => (refreshNote = ` (Refresh failed: ${String(e)})`));
      setMessage(
        `Purchase posted (${lineCount} line${lineCount === 1 ? '' : 's'}) and stock updated.${refreshNote}`,
      );
    } finally {
      setPurchaseBusy(false);
    }
  }
  async function changePrice(ev: Event) {
    ev.preventDefault();
    if (!shopId) {
      setError('Shop data is still loading.');
      return;
    }
    if (!selected) return;
    const f = new FormData(ev.currentTarget as HTMLFormElement);
    try {
      await setItemPrice({
        itemId: selected,
        shopId,
        kind: String(f.get('kind')) as ItemPrice['kind'],
        unitLevel: Number(f.get('unitLevel')) as 1 | 2 | 3,
        pricePaise: paise(String(f.get('price'))),
        clientId: crypto.randomUUID(),
      });
      const updatedPrices = await listCurrentPrices(selected);
      if (selectedRef.current === selected) setPrices(updatedPrices);
      setMessage('Price history updated atomically.');
    } catch (e) {
      setError(String(e));
    }
  }
  async function changeImage(ev: Event) {
    const file = (ev.currentTarget as HTMLInputElement).files?.[0];
    if (!file || !selectedItem) return;
    try {
      const blob = await compressItemImage(file);
      const path = await replaceItemImage({
        tenantId,
        itemId: selectedItem.id,
        blob,
        oldPath: selectedItem.image_path,
      });
      setMessage(`Image stored (${Math.round(blob.size / 1024)} KB).`);
      setItems((v) => v.map((i) => (i.id === selectedItem.id ? { ...i, image_path: path } : i)));
    } catch (e) {
      setError(String(e));
    }
  }
  async function changeMinStock(ev: Event) {
    ev.preventDefault();
    if (!selectedItem) return;
    const f = new FormData(ev.currentTarget as HTMLFormElement);
    try {
      const updated = await setItemMinStock(selectedItem.id, Number(f.get('minStock')));
      setItems((v) => v.map((i) => (i.id === updated.id ? updated : i)));
      setMessage('Reorder threshold saved.');
    } catch (e) {
      setError(String(e));
    }
  }

  return (
    <main>
      <p>
        <a href={appRoute.home}>← Home</a>
      </p>
      <h1>Inventory & purchases</h1>
      <TaskTabs
        label="Stock tasks"
        value={view}
        onChange={setView}
        options={[
          { value: 'items', label: 'Items' },
          { value: 'purchase', label: 'Purchases' },
          { value: 'suppliers', label: 'Suppliers' },
          { value: 'advanced', label: 'Advanced' },
        ]}
      />
      {(purchaseLocked || purchaseStorageBlocked) && (
        <p role="alert">
          A purchase needs attention.{' '}
          <button type="button" onClick={() => setView('purchase')}>
            Review pending purchase
          </button>
        </p>
      )}
      <section class="card" hidden={view !== 'items'} aria-label="Stock items">
        <label class="search-field">
          Find stock item
          <input
            value={itemSearch}
            placeholder="Name or SKU"
            onInput={(e) => setItemSearch(e.currentTarget.value)}
          />
        </label>
        <button
          type="button"
          onClick={() => {
            const form = document.getElementById('stock-add-item') as HTMLDetailsElement | null;
            if (form) form.open = true;
            document.getElementById('stock-item-details')?.scrollIntoView({ block: 'start' });
          }}
        >
          New item
        </button>
        <div class="record-list">
          {items
            .filter((item) =>
              (item.name + ' ' + (item.sku ?? '')).toLowerCase().includes(itemSearch.toLowerCase()),
            )
            .slice(0, 50)
            .map((item) => (
              <button
                type="button"
                key={item.id}
                onClick={() => {
                  setSelected(item.id);
                  requestAnimationFrame(() =>
                    document
                      .getElementById('stock-item-details')
                      ?.scrollIntoView({ block: 'start' }),
                  );
                }}
              >
                <span>
                  <strong>{item.name}</strong>
                  <small>{item.sku || 'No SKU'}</small>
                </span>
                <span class="record-value">
                  {stock.find((row) => row.item_id === item.id)?.qty_base ?? '—'}
                  <small>{item.unit3 || item.unit2 || item.unit1}</small>
                </span>
              </button>
            ))}
        </div>
        <p class="muted">Showing up to 50 matches · {items.length} items</p>
      </section>
      {error && <p role="alert">{error}</p>}
      {message && <p role="status">{message}</p>}
      <section hidden={view !== 'advanced'} aria-label="Import old DSB backup">
        <h2>Import old DSB backup</h2>
        <p class="muted">
          Shop-test setup only. This imports the current item master, sale prices, current stock,
          suppliers and real customers. It does not copy historical purchase bills, sales invoices
          or payments.
        </p>
        <input
          aria-label="Choose DSB backup JSON"
          type="file"
          accept=".json,application/json"
          onChange={chooseLegacyBackup}
        />
        {legacyPlan && (
          <div class="card">
            <strong>{legacyFileName}</strong>
            <br />
            Ready: {legacyPlan.items.length} items · {legacyPlan.parties.length} suppliers ·{' '}
            {legacyPlan.customers.length} customers ·{' '}
            {legacyPlan.items.reduce((n, i) => n + i.prices.length, 0)} price rows ·{' '}
            {legacyPlan.items.filter((i) => i.openingStockSmallest > 0).length} positive stock
            balances.
            {legacyPlan.warnings.length > 0 && (
              <>
                <p>
                  <strong>{legacyPlan.warnings.length} warnings</strong> (nothing is silently
                  guessed):
                </p>
                <ul>
                  {legacyPlan.warnings.slice(0, 6).map((w, n) => (
                    <li key={n}>{w}</li>
                  ))}
                </ul>
                {legacyPlan.warnings.length > 6 && (
                  <p>
                    …and {legacyPlan.warnings.length - 6} more. Items without a usable sale price
                    remain unsellable until a price is added.
                  </p>
                )}
              </>
            )}
            <p>
              <button
                type="button"
                class="primary"
                disabled={legacyBusy || !shopId}
                onClick={() => void runLegacyImport()}
              >
                {legacyBusy ? 'Importing…' : 'Import checked backup'}
              </button>
            </p>
          </div>
        )}
      </section>
      <section id="stock-item-details" hidden={view !== 'items'}>
        <h2>Item setup</h2>
        <p>
          Unit order follows DSB: big → small → piece. Stock is stored in the smallest configured
          unit.
        </p>
        <details id="stock-add-item">
          <summary>Add item</summary>
          <form onSubmit={addItem}>
            <label>
              Item name <input name="name" placeholder="Item name" required />
            </label>{' '}
            <label>
              SKU <input name="sku" placeholder="SKU" />
            </label>{' '}
            <label>
              Big unit (e.g. case){' '}
              <input name="unit1" placeholder="Big unit (e.g. case)" required />
            </label>{' '}
            <label>
              Small unit (e.g. pack) <input name="unit2" placeholder="Small unit (e.g. pack)" />
            </label>{' '}
            <label>
              Small units per big{' '}
              <input
                name="conv1"
                type="number"
                min="0"
                step="any"
                placeholder="Small units per big"
              />
            </label>{' '}
            <label>
              Piece unit (optional) <input name="unit3" placeholder="Piece unit (optional)" />
            </label>{' '}
            <label>
              Pieces per small{' '}
              <input name="conv2" type="number" min="0" step="any" placeholder="Pieces per small" />
            </label>{' '}
            <button disabled={!tenantId}>Create item</button>
          </form>
        </details>
        <label>
          Item details{' '}
          <select
            value={selected}
            onChange={(e) => setSelected((e.currentTarget as HTMLSelectElement).value)}
          >
            <option value="">Choose…</option>
            {items.map((i) => (
              <option key={i.id} value={i.id}>
                {i.name}
              </option>
            ))}
          </select>
        </label>
        {selectedItem && (
          <div aria-label="item peek">
            <strong>{selectedItem.name}</strong> · Stock {selectedStock}{' '}
            {selectedItem.unit3 || selectedItem.unit2 || selectedItem.unit1}
            <br />
            Current prices:{' '}
            {pricesLoading
              ? 'Loading…'
              : pricesFailed
                ? 'Unavailable'
                : prices.length
                  ? prices.map((p) => `${p.kind} ₹${(p.price_paise / 100).toFixed(2)}`).join(' · ')
                  : 'none'}
            <br />
            Reorder at: {selectedItem.min_stock}{' '}
            {selectedItem.unit3 || selectedItem.unit2 || selectedItem.unit1}
            <br />
            <input type="file" accept="image/*" onChange={changeImage} />
          </div>
        )}
        {selectedItem && (
          <form onSubmit={changeMinStock}>
            <label>
              Reorder threshold ({selectedItem.unit3 || selectedItem.unit2 || selectedItem.unit1}){' '}
              <input
                name="minStock"
                type="number"
                min="0"
                step="any"
                defaultValue={selectedItem.min_stock}
                key={selectedItem.id}
              />
            </label>{' '}
            <button disabled={!shopId}>Save reorder threshold</button>
          </form>
        )}
        {selectedItem && (
          <form onSubmit={addBarcode}>
            <label>
              Barcode <input name="barcode" placeholder="Barcode" required />
            </label>{' '}
            <select aria-label="Unit" name="unitLevel">
              <option value="1">{selectedItem.unit1}</option>
              {selectedItem.unit2 && <option value="2">{selectedItem.unit2}</option>}
              {selectedItem.unit3 && <option value="3">{selectedItem.unit3}</option>}
            </select>{' '}
            <button disabled={!tenantId}>Link barcode</button>
          </form>
        )}
        {selectedItem && (
          <form onSubmit={changePrice}>
            <select name="kind">
              <option value="retail">Retail</option>
              <option value="wholesale">Wholesale</option>
              <option value="mrp">MRP</option>
              <option value="cost_last">Last cost</option>
            </select>{' '}
            <select aria-label="Unit" name="unitLevel">
              <option value="1">{selectedItem.unit1}</option>
              {selectedItem.unit2 && <option value="2">{selectedItem.unit2}</option>}
              {selectedItem.unit3 && <option value="3">{selectedItem.unit3}</option>}
            </select>{' '}
            <label>
              ₹ price{' '}
              <input
                name="price"
                type="number"
                min="0"
                step="0.01"
                placeholder="₹ price"
                required
              />
            </label>{' '}
            <button disabled={!shopId}>Set price</button>
          </form>
        )}
      </section>
      <section hidden={view !== 'suppliers'}>
        <h2>Suppliers</h2>
        <form onSubmit={addParty}>
          <label>
            Supplier name <input name="name" placeholder="Supplier name" required />
          </label>{' '}
          <label>
            Phone <input name="phone" placeholder="Phone" />
          </label>{' '}
          <label>
            GSTIN <input name="gstin" placeholder="GSTIN" />
          </label>{' '}
          <button disabled={!tenantId}>Create supplier</button>
        </form>
      </section>
      <section hidden={view !== 'purchase'}>
        <h2>Post purchase</h2>
        <form onSubmit={addPurchase}>
          {purchaseLocked && (
            <p class="alert" role="alert">
              The last purchase may already be saved. Editing is locked: press “Retry same purchase”
              — it never posts the bill twice.
            </p>
          )}
          <fieldset disabled={purchaseLocked} class="plain">
            <label>
              Bill no. <input name="billNo" placeholder="Bill no." />
            </label>{' '}
            <label>
              Business date
              <input
                name="date"
                type="date"
                value={businessDate}
                onInput={(e) => setBusinessDate((e.currentTarget as HTMLInputElement).value)}
                required
              />
            </label>{' '}
            <label>
              Supplier
              <select name="partyId">
                <option value="">No supplier</option>
                {parties.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </label>{' '}
            <label>
              Discount ₹{' '}
              <input name="discount" type="number" min="0" step="0.01" placeholder="Discount ₹" />
            </label>{' '}
            <label>
              Extra ₹ <input name="extra" type="number" min="0" step="0.01" placeholder="Extra ₹" />
            </label>
            <fieldset>
              <legend>Add purchase line</legend>
              <select
                aria-label="Purchase item"
                name="itemId"
                value={purchaseLineItemId}
                onChange={(e) => {
                  setPurchaseLineItemId((e.currentTarget as HTMLSelectElement).value);
                  setPurchaseLineUnitLevel(1);
                }}
              >
                <option value="">Item…</option>
                {items.map((i) => (
                  <option key={i.id} value={i.id}>
                    {i.name}
                  </option>
                ))}
              </select>{' '}
              <select
                aria-label="Unit"
                name="unitLevel"
                disabled={!purchaseLineItem}
                value={purchaseLineUnitLevel}
                onChange={(e) =>
                  setPurchaseLineUnitLevel(
                    Number((e.currentTarget as HTMLSelectElement).value) as 1 | 2 | 3,
                  )
                }
              >
                <option value="1">{purchaseLineItem?.unit1 || 'Big unit'}</option>
                {purchaseLineItem?.unit2 && <option value="2">{purchaseLineItem.unit2}</option>}
                {purchaseLineItem?.unit3 && <option value="3">{purchaseLineItem.unit3}</option>}
              </select>{' '}
              <label>
                Quantity
                <input
                  name="qty"
                  type="number"
                  min="0.000001"
                  step="any"
                  placeholder="Qty"
                  value={purchaseLineQty}
                  onInput={(e) => setPurchaseLineQty((e.currentTarget as HTMLInputElement).value)}
                />
              </label>{' '}
              <label>
                Unit cost ₹
                <input
                  name="price"
                  type="number"
                  min="0"
                  step="0.01"
                  placeholder="Unit cost ₹"
                  value={purchaseLinePrice}
                  onInput={(e) => setPurchaseLinePrice((e.currentTarget as HTMLInputElement).value)}
                />
              </label>{' '}
              <button type="button" onClick={addPurchaseLine}>
                Add line
              </button>
            </fieldset>
            {purchaseCart.length > 0 && (
              <div class="table-wrap mobile-records" aria-label="Purchase cart">
                <table>
                  <thead>
                    <tr>
                      <th>Item</th>
                      <th>Qty</th>
                      <th>Unit cost</th>
                      <th>Line total</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {purchaseCart.map((l, n) => (
                      <tr key={n}>
                        <td class="record-title" data-label="Item">
                          {l.item.name}
                          <small> {unitLabel(l.item, l.unitLevel)}</small>
                        </td>
                        <td data-label="Quantity">{l.qty}</td>
                        <td data-label="Unit cost">₹{(l.unitPricePaise / 100).toFixed(2)}</td>
                        <td data-label="Line total">
                          ₹{(quantityTimesPaise(l.qty, l.unitPricePaise) / 100).toFixed(2)}
                        </td>
                        <td>
                          <button
                            type="button"
                            aria-label={`Remove purchase line ${n + 1}`}
                            onClick={() => removePurchaseLine(n)}
                          >
                            Remove
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <p>Lines total: ₹{(purchaseTotalPaise / 100).toFixed(2)}</p>
              </div>
            )}
          </fieldset>
          <button
            class="primary"
            disabled={
              purchaseBusy || !shopId || !businessDate || (!purchaseCart.length && !purchaseLocked)
            }
          >
            {purchaseBusy ? 'Posting…' : purchaseLocked ? 'Retry same purchase' : 'Post purchase'}
          </button>
        </form>
      </section>
    </main>
  );
}
