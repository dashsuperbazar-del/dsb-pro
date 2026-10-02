import { getSession, getShopSettings, type PrinterWidth } from '@dsb-pro/adapters';

// D2a: the issuer details printed on receipts. Read from the server when online and cached per
// user and shop (a shop id belongs to exactly one tenant) so an offline receipt can still show
// them; never invented ("DSB Store").
export type ShopProfile = {
  shopId: string;
  name: string;
  address: string | null;
  gstin: string | null;
  printerWidth: PrinterWidth;
  fetchedAt: string;
};
export type ProfileLoad = { profile: ShopProfile | null; fromCache: boolean };

const cacheKey = (user: string, shop: string) => `dsb-shop-profile:${user}:${shop}`;
const SERVER_TIMEOUT_MS = 5000;

function readCache(key: string): ShopProfile | null {
  try {
    const raw = localStorage.getItem(key);
    const p = raw ? (JSON.parse(raw) as ShopProfile) : null;
    return p && typeof p.name === 'string' ? p : null;
  } catch {
    return null;
  }
}

export async function loadShopProfile(shopId: string): Promise<ProfileLoad> {
  let key: string | null = null;
  try {
    const session = await getSession(); // local; no network
    if (session) key = cacheKey(session.user.id, shopId);
  } catch {
    /* identity unknown: no cache is read or written */
  }
  if (!shopId) return { profile: null, fromCache: false };
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const s = await Promise.race([
      getShopSettings(shopId),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('timeout')), SERVER_TIMEOUT_MS);
      }),
    ]).finally(() => clearTimeout(timer));
    const profile: ShopProfile = {
      shopId,
      name: s.name,
      address: s.address,
      gstin: s.gstin,
      printerWidth: s.printerWidth,
      fetchedAt: new Date().toISOString(),
    };
    if (key) {
      try {
        localStorage.setItem(key, JSON.stringify(profile));
      } catch {
        /* cache is a convenience only */
      }
    }
    return { profile, fromCache: false };
  } catch {
    const cached = key ? readCache(key) : null;
    return { profile: cached, fromCache: Boolean(cached) };
  }
}
