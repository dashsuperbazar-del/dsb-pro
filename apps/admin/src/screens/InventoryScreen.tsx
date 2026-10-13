import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import {
  addItemBarcode,
  createItem,
  createParty,
  getCurrentMembership,
  getPurchaseDetail,
  listPurchaseHistory,
  type PurchaseRecord,
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
import { repeatPurchase, rankedPurchaseParties } from '../lib/purchaseWorkflow';
import { paiseToDecimal, rupees } from '../lib/money';
import { compressItemImage } from '../lib/compressImage';
import { TaskTabs } from '../components/TaskTabs';
import { appRoute } from '../lib/paths';
import { clearPendingIntent, loadPendingIntent, savePendingIntent } from '../lib/pendingIntent';

const paise = (rupees: string) => parseRupeesToPaise(rupees || '0');

export function InventoryScreen({
  purchaseOnly = false,
  purchaseContextActive = true,
  purchaseSupplierId = '',
  purchaseRepeatId = '',
  onPurchasePosted,
}: {
  purchaseOnly?: boolean;
  purchaseContextActive?: boolean;
  purchaseSupplierId?: string;
  purchaseRepeatId?: string;
  onPurchasePosted?: () => void;
} = {}) {
  type View = 'items' | 'purchase' | 'suppliers' | 'advanced';
  const initial = new URLSearchParams(window.location.search).get('view');
  const [view, setView] = useState<View>(
    purchaseOnly
      ? 'purchase'
      : initial === 'purchase' || initial === 'suppliers' || initial === 'advanced'
        ? initial
        : 'items',
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
  const [purchaseSupplier, setPurchaseSupplier] = useState('');
  const [purchaseBillNo, setPurchaseBillNo] = useState('');
  const [purchaseDiscount, setPurchaseDiscount] = useState('');
  const [purchaseExtra, setPurchaseExtra] = useState('');
  const [purchaseItemSearch, setPurchaseItemSearch] = useState('');
  const [recentBills, setRecentBills] = useState<PurchaseRecord[]>([]);
  const [recentDetail, setRecentDetail] = useState<Awaited<
    ReturnType<typeof getPurchaseDetail>
  > | null>(null);
  const contextApplied = useRef('');
  const contextNeedsReset = useRef(false);
  const [catalogLoaded, setCatalogLoaded] = useState(false);
  const itemsRef = useRef(items);
  itemsRef.current = items;
  const partiesRef = useRef(parties);
  partiesRef.current = parties;
  const [contextBusy, setContextBusy] = useState(false);
  const [editingPurchaseLine, setEditingPurchaseLine] = useState<number | null>(null);
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
    setCatalogLoaded(true);
    setBusinessDate((value) => value || d);
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
  useEffect(() => {
    if (!shopId || !purchaseOnly) return;
    let active = true;
    void listPurchaseHistory(shopId)
      .then((b) => {
        if (active) setRecentBills(b);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [shopId, purchaseOnly]);
  useEffect(() => {
    setRecentDetail(null);
    if (!shopId || !purchaseSupplier || !purchaseOnly) return;
    const latest = recentBills.find(
      (b) => b.party_id === purchaseSupplier && b.status === 'POSTED',
    );
    if (!latest) return;
    let active = true;
    void getPurchaseDetail(shopId, latest.id)
      .then((d) => {
        if (active) setRecentDetail(d);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [shopId, purchaseSupplier, recentBills, purchaseOnly]);
  useEffect(() => {
    const intent = purchaseSupplierId + ':' + purchaseRepeatId;
    if (
      (!purchaseContextActive || intent !== contextApplied.current) &&
      contextNeedsReset.current
    ) {
      contextApplied.current = '';
      contextNeedsReset.current = false;
    }
    if (
      !purchaseOnly ||
      !purchaseContextActive ||
      !shopId ||
      !catalogLoaded ||
      contextNeedsReset.current
    )
      return;
    if (contextApplied.current === intent) return;
    if (lockedPurchase.current || purchaseStorageBlocked) {
      setError('Resolve the pending purchase before starting or repeating another bill.');
      return;
    }
    contextApplied.current = intent;
    if (
      (purchaseCart.length ||
        purchaseBillNo ||
        purchaseDiscount ||
        purchaseExtra ||
        purchaseLineQty ||
        purchaseLinePrice) &&
      !confirm('Replace this unfinished purchase with the selected new draft?')
    ) {
      contextNeedsReset.current = true;
      return;
    }
    let active = true;
    let completed = false;
    setContextBusy(true);
    void (async () => {
      try {
        const newDate = await getShopBusinessDate(shopId);
        if (!active) return;
        if (purchaseRepeatId) {
          const d = await getPurchaseDetail(shopId, purchaseRepeatId);
          const cart = repeatPurchase(d.bill, d.lines, itemsRef.current);
          if (!active) return;
          if (d.bill.party_id && !partiesRef.current.some((p) => p.id === d.bill.party_id))
            throw new Error('The original supplier is unavailable. Start a new purchase manually.');
          setPurchaseSupplier(d.bill.party_id || '');
          setPurchaseCart(cart);
          setPurchaseDiscount(paiseToDecimal(d.bill.discount_paise));
          setPurchaseExtra(paiseToDecimal(d.bill.extra_charges_paise));
          setMessage(
            `Draft repeated from ${d.bill.bill_no || d.bill.id.slice(0, 8)} (${d.bill.business_date}). Historical costs and adjustments copied — review them. This is a new purchase, not posted yet.`,
          );
        } else {
          if (purchaseSupplierId && !partiesRef.current.some((p) => p.id === purchaseSupplierId))
            throw new Error('Supplier is unavailable.');
          setPurchaseSupplier(purchaseSupplierId);
          setPurchaseCart([]);
          setPurchaseDiscount('');
          setPurchaseExtra('');
        }
        setBusinessDate(newDate);
        setPurchaseBillNo('');
        setEditingPurchaseLine(null);
        setPurchaseItemSearch('');
        setPurchaseLineItemId('');
        setPurchaseLineQty('');
        setPurchaseLinePrice('');
        setPurchaseClientId(crypto.randomUUID());
        completed = true;
      } catch (e) {
        if (active) {
          setError(String(e));
          contextNeedsReset.current = true;
        }
      } finally {
        if (active) setContextBusy(false);
      }
    })();
    return () => {
      active = false;
      if (!completed) contextApplied.current = '';
      setContextBusy(false);
    };
  }, [
    shopId,
    catalogLoaded,
    purchaseSupplierId,
    purchaseRepeatId,
    purchaseOnly,
    purchaseContextActive,
    purchaseLocked,
    purchaseStorageBlocked,
  ]);
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
  const payablePreview = (() => {
    try {
      return rupees(purchaseTotalPaise - paise(purchaseDiscount) + paise(purchaseExtra));
    } catch {
      return 'Check amounts';
    }
  })();
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
      if (purchaseOnly) setPurchaseSupplier(party.id);
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
    const line = { item, unitLevel: purchaseLineUnitLevel, qty, unitPricePaise };
    setPurchaseCart((v) =>
      editingPurchaseLine === null
        ? [...v, line]
        : v.map((old, n) => (n === editingPurchaseLine ? line : old)),
    );
    setEditingPurchaseLine(null);
    setPurchaseItemSearch('');
    setPurchaseLineItemId('');
    setPurchaseLineUnitLevel(1);
    setPurchaseLineQty('');
    setPurchaseLinePrice('');
  }
  function removePurchaseLine(index: number) {
    setPurchaseCart((v) => v.filter((_, i) => i !== index));
    setEditingPurchaseLine(null);
    setPurchaseLineItemId('');
    setPurchaseLineQty('');
    setPurchaseLinePrice('');
  }
  async function addPurchase(ev: Event) {
    ev.preventDefault();
    if (purchaseBusy || contextBusy) return;
    setError('');
    if (!purchaseLocked && editingPurchaseLine !== null) {
      setError('Update or cancel the line edit before posting this purchase.');
      return;
    }
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
      if (request.clientId === purchaseClientId) {
        setPurchaseCart([]);
        setPurchaseBillNo('');
        setPurchaseDiscount('');
        setPurchaseExtra('');
        setEditingPurchaseLine(null);
        setPurchaseLineItemId('');
        setPurchaseItemSearch('');
        setPurchaseLineQty('');
        setPurchaseLinePrice('');
        contextNeedsReset.current = true;
      }
      onPurchasePosted?.();
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

  const Container = purchaseOnly ? 'section' : 'main';
  return (
    <Container>
      <p hidden={purchaseOnly}>
        <a href={appRoute.home}>← Home</a>
      </p>
      {!purchaseOnly && <h1>Inventory & purchases</h1>}
      {!purchaseOnly && (
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
      )}
      {(purchaseLocked || purchaseStorageBlocked) && (
        <p role="alert">
          A purchase needs attention.{' '}
          <button type="button" onClick={() => setView('purchase')}>
            Review pending purchase
          </button>
        </p>
      )}
      <section class="card" hidden={purchaseOnly || view !== 'items'} aria-label="Stock items">
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
   …4678 tokens truncated…                    </td>
                        <td>
                          {purchaseOnly && (
                            <button
                              type="button"
                              aria-label={`Edit purchase line ${n + 1}`}
                              onClick={() => {
                                setEditingPurchaseLine(n);
                                setPurchaseItemSearch(l.item.name);
                                setPurchaseLineItemId(l.item.id);
                                setPurchaseLineUnitLevel(l.unitLevel);
                                setPurchaseLineQty(l.qty);
                                setPurchaseLinePrice(paiseToDecimal(l.unitPricePaise));
                              }}
                            >
                              Edit
                            </button>
                          )}
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
                <p>Lines total: {rupees(purchaseTotalPaise)}</p>
                <p>
                  <strong>Payable preview: {payablePreview}</strong>
                </p>
              </div>
            )}
          </fieldset>
          <button
            class="primary"
            disabled={
              purchaseBusy ||
              contextBusy ||
              (!purchaseLocked && editingPurchaseLine !== null) ||
              !shopId ||
              !businessDate ||
              (!purchaseCart.length && !purchaseLocked)
            }
          >
            {purchaseBusy ? 'Posting…' : purchaseLocked ? 'Retry same purchase' : 'Post purchase'}
          </button>
        </form>
      </section>
    </Container>
  );
}
