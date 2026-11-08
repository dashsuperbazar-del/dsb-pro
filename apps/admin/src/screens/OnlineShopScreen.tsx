import { useEffect, useMemo, useState } from 'preact/hooks';
import {
  getCurrentMembership,
  getDefaultShopId,
  getStorefrontSettings,
  listItems,
  listStorefrontItems,
  saveStorefrontItems,
  saveStorefrontSettings,
  type Item,
  type StorefrontSettings,
} from '@dsb-pro/adapters';
import { appRoute } from '../lib/paths';
import { errorText } from '../lib/friendlyError';
import { paiseToRupeesText, rupeesTextToPaise } from '../lib/supplierPayForm';

// SF0: online shop settings and which items are sold online (old DSB storefront admin, G03/G09).
// Nothing is public until "Shop is open online" is on AND the public shop (later packet) is live.
const blank: StorefrontSettings = {
  enabled: false,
  slug: '',
  displayName: '',
  publicContact: null,
  pickupNote: null,
  orderHours: null,
  reservationMinutes: 30,
  maxLines: 50,
  pickupEnabled: true,
  deliveryEnabled: false,
  deliveryFeePaise: 0,
  minOrderPaise: 0,
  freeDeliveryAbovePaise: null,
  deliverySlots: [],
  deliveryNote: null,
};
const toSlug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
const money = (p: number | null) => (p === null ? '' : paiseToRupeesText(BigInt(p)));

export function OnlineShopScreen() {
  const [shopId, setShopId] = useState('');
  const [canEdit, setCanEdit] = useState(false);
  const [s, setS] = useState<StorefrontSettings>(blank);
  const [fee, setFee] = useState('0.00');
  const [minOrder, setMinOrder] = useState('0.00');
  const [freeAbove, setFreeAbove] = useState('');
  const [slots, setSlots] = useState('');
  const [items, setItems] = useState<Item[]>([]);
  const [published, setPublished] = useState<Map<string, boolean>>(new Map());
  const [changed, setChanged] = useState<Set<string>>(new Set());
  const [find, setFind] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    void (async () => {
      try {
        const [shop, m] = await Promise.all([getDefaultShopId(), getCurrentMembership()]);
        setShopId(shop);
        setCanEdit(m?.role === 'owner' || m?.role === 'manager');
        const [cfg, list, pub] = await Promise.all([
          getStorefrontSettings(shop),
          listItems(),
          listStorefrontItems(shop),
        ]);
        const v = cfg ?? blank;
        setS(v);
        setFee(money(v.deliveryFeePaise));
        setMinOrder(money(v.minOrderPaise));
        setFreeAbove(money(v.freeDeliveryAbovePaise));
        setSlots(v.deliverySlots.join('\n'));
        setItems(list);
        setPublished(new Map(pub.map((p) => [p.itemId, p.published])));
      } catch (e) {
        setError(errorText(e));
      }
    })();
  }, []);

  const shown = useMemo(() => {
    const f = find.trim().toLowerCase();
    return items.filter((i) => !f || i.name.toLowerCase().includes(f)).slice(0, 300);
  }, [items, find]);
  const publishedCount = [...published.values()].filter(Boolean).length;
  const set = <K extends keyof StorefrontSettings>(k: K, v: StorefrontSettings[K]) =>
    setS((x) => ({ ...x, [k]: v }));

  async function saveSettings(ev: Event) {
    ev.preventDefault();
    setError('');
    setMsg('');
    const f = rupeesTextToPaise(fee || '0');
    const mo = rupeesTextToPaise(minOrder || '0');
    const fa = freeAbove.trim() ? rupeesTextToPaise(freeAbove) : null;
    if (f === null || mo === null || (freeAbove.trim() && fa === null))
      return setError('Enter amounts in rupees, like 30 or 30.50.');
    const slotList = slots
      .split('\n')
      .map((x) => x.trim())
      .filter(Boolean);
    setBusy(true);
    try {
      await saveStorefrontSettings(
        shopId,
        {
          ...s,
          slug: toSlug(s.slug || s.displayName),
          deliveryFeePaise: Number(f),
          minOrderPaise: Number(mo),
          freeDeliveryAbovePaise: fa === null ? null : Number(fa),
          deliverySlots: slotList,
        },
        crypto.randomUUID(),
      );
      setS((x) => ({ ...x, slug: toSlug(x.slug || x.displayName), deliverySlots: slotList }));
      setMsg('Online shop settings saved.');
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  async function saveItems() {
    setError('');
    setMsg('');
    setBusy(true);
    try {
      const n = await saveStorefrontItems(
        shopId,
        [...changed].map((id) => ({
          itemId: id,
          published: published.get(id) ?? false,
          description: null,
        })),
        crypto.randomUUID().slice(0, 36),
      );
      setChanged(new Set());
      setMsg(`${n} item${n === 1 ? '' : 's'} updated.`);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  function toggle(id: string, on: boolean) {
    setPublished((m) => new Map(m).set(id, on));
    setChanged((c) => new Set(c).add(id));
  }
  function setAllShown(on: boolean) {
    setPublished((m) => {
      const n = new Map(m);
      for (const i of shown) n.set(i.id, on);
      return n;
    });
    setChanged((c) => {
      const n = new Set(c);
      for (const i of shown) n.add(i.id);
      return n;
    });
  }

  const ro = !canEdit || busy;
  return (
    <main class="page wide" data-testid="online-shop">
      <p>
        <a class="back-home" href={appRoute.more}>
          ← Shop tools
        </a>
      </p>
      <h1>Online shop</h1>
      {!canEdit && <p class="muted">Only the owner or a manager can change these settings.</p>}
      {error && (
        <p role="alert" class="alert">
          {error}
        </p>
      )}
      {msg && <p role="status">{msg}</p>}
      <form onSubmit={saveSettings} class="settings-form">
        <fieldset disabled={ro}>
          <legend>Shop</legend>
          <label>
            <input
              type="checkbox"
              checked={s.enabled}
              onChange={(e) => set('enabled', (e.currentTarget as HTMLInputElement).checked)}
            />{' '}
            Shop is open online
          </label>
          <label>
            Shop name online{' '}
            <input
              required
              maxLength={80}
              value={s.displayName}
              onInput={(e) => set('displayName', (e.currentTarget as HTMLInputElement).value)}
            />
          </label>
          <label>
            Web address name{' '}
            <input
              maxLength={40}
              value={s.slug}
              placeholder="dsb-store"
              onInput={(e) => set('slug', (e.currentTarget as HTMLInputElement).value)}
            />
          </label>
          <label>
            Contact shown to customers{' '}
            <input
              maxLength={80}
              value={s.publicContact ?? ''}
              onInput={(e) =>
                set('publicContact', (e.currentTarget as HTMLInputElement).value || null)
              }
            />
          </label>
          <label>
            Order hours{' '}
            <input
              maxLength={120}
              value={s.orderHours ?? ''}
              placeholder="8 am – 9 pm"
              onInput={(e) =>
                set('orderHours', (e.currentTarget as HTMLInputElement).value || null)
              }
            />
          </label>
          <label>
            Hold stock for an order (minutes){' '}
            <input
              type="number"
              min={5}
              max={120}
              value={s.reservationMinutes}
              onInput={(e) =>
                set('reservationMinutes', Number((e.currentTarget as HTMLInputElement).value))
              }
            />
          </label>
        </fieldset>
        <fieldset disabled={ro}>
          <legend>Pickup</legend>
          <label>
            <input
              type="checkbox"
              checked={s.pickupEnabled}
              onChange={(e) => set('pickupEnabled', (e.currentTarget as HTMLInputElement).checked)}
            />{' '}
            Customers can pick up at the shop
          </label>
          <label>
            Pickup note{' '}
            <input
              maxLength={300}
              value={s.pickupNote ?? ''}
              onInput={(e) =>
                set('pickupNote', (e.currentTarget as HTMLInputElement).value || null)
              }
            />
          </label>
        </fieldset>
        <fieldset disabled={ro}>
          <legend>Delivery</legend>
          <label>
            <input
              type="checkbox"
              checked={s.deliveryEnabled}
              onChange={(e) =>
                set('deliveryEnabled', (e.currentTarget as HTMLInputElement).checked)
              }
            />{' '}
            We deliver
          </label>
          <label>
            Delivery fee ₹{' '}
            <input
              inputMode="decimal"
              value={fee}
              onInput={(e) => setFee((e.currentTarget as HTMLInputElement).value)}
            />
          </label>
          <label>
            Minimum order ₹{' '}
            <input
              inputMode="decimal"
              value={minOrder}
              onInput={(e) => setMinOrder((e.currentTarget as HTMLInputElement).value)}
            />
          </label>
          <label>
            Free delivery above ₹ (blank = never){' '}
            <input
              inputMode="decimal"
              value={freeAbove}
              onInput={(e) => setFreeAbove((e.currentTarget as HTMLInputElement).value)}
            />
          </label>
          <label>
            Delivery time slots (one per line, up to 12){' '}
            <textarea
              rows={3}
              value={slots}
              placeholder={'9–11 am\n5–7 pm'}
              onInput={(e) => setSlots((e.currentTarget as HTMLTextAreaElement).value)}
            />
          </label>
          <label>
            Delivery note{' '}
            <input
              maxLength={300}
              value={s.deliveryNote ?? ''}
              onInput={(e) =>
                set('deliveryNote', (e.currentTarget as HTMLInputElement).value || null)
              }
            />
          </label>
        </fieldset>
        <button type="submit" class="primary" disabled={ro || !shopId}>
          Save online shop settings
        </button>
      </form>

      <section class="card" aria-label="Items sold online">
        <h2>
          Items sold online <small class="muted">({publishedCount} published)</small>
        </h2>
        <input
          type="search"
          placeholder="Find an item"
          aria-label="Find an item"
          value={find}
          onInput={(e) => setFind((e.currentTarget as HTMLInputElement).value)}
        />{' '}
        <button type="button" disabled={ro} onClick={() => setAllShown(true)}>
          Publish all shown
        </button>{' '}
        <button type="button" disabled={ro} onClick={() => setAllShown(false)}>
          Hide all shown
        </button>
        <ul class="record-list" data-testid="online-items">
          {shown.map((i) => (
            <li key={i.id}>
              <label>
                <input
                  type="checkbox"
                  disabled={ro}
                  checked={published.get(i.id) ?? false}
                  onChange={(e) => toggle(i.id, (e.currentTarget as HTMLInputElement).checked)}
                />{' '}
                {i.name}
              </label>
            </li>
          ))}
        </ul>
        {items.length > shown.length && (
          <p class="muted">
            Showing {shown.length} of {items.length}. Use Find to narrow.
          </p>
        )}
        <button
          type="button"
          class="primary"
          disabled={ro || changed.size === 0}
          onClick={() => void saveItems()}
        >
          Save {changed.size || ''} item change{changed.size === 1 ? '' : 's'}
        </button>
      </section>
    </main>
  );
}
