import {
  getSession,
  getCurrentMembership,
  getDefaultShopId,
  getShopBusinessDate,
  onAuthStateChange,
  type Membership,
  type Session,
} from '@dsb-pro/adapters';

// Every screen used to re-read membership, default shop, session and business date on open. This shares one
// short-lived answer between screens. It is deliberately not a store: a result lives 30 s (date: 60 s), is
// keyed to the signed-in user, and is dropped on any auth event, window focus or reconnect. A read that
// began before an invalidation is discarded, so an old identity's answer can never reach a new one.
export type ShopContext = { session: Session; membership: Membership; shopId: string };

const CONTEXT_TTL_MS = 30_000;
const DATE_TTL_MS = 60_000;

type Deps = {
  now: () => number;
  getSession: () => Promise<Session | null>;
  getMembership: () => Promise<Membership | null>;
  getDefaultShopId: () => Promise<string>;
  getBusinessDate: (shopId: string) => Promise<string>;
  onAuthChange: (cb: (session: unknown) => void) => () => void;
};

class StaleRead extends Error {}

export function createShopContext(deps: Deps) {
  let generation = 0;
  let stored: { userId: string; at: number; value: ShopContext } | null = null;
  let inflight: { userId: string; generation: number; promise: Promise<ShopContext> } | null = null;
  const dates = new Map<string, { at: number; generation: number; value: string }>();
  let wired = false;

  function invalidate() {
    generation++;
    stored = null;
    inflight = null;
    dates.clear();
  }
  function wire() {
    if (wired) return;
    wired = true;
    try {
      deps.onAuthChange(invalidate);
    } catch {
      // No auth client yet (tests, signed-out boot): focus/reconnect/ttl still bound the answer.
    }
    if (typeof window !== 'undefined') {
      window.addEventListener('focus', invalidate);
      window.addEventListener('online', invalidate);
    }
  }

  async function get(attempt = 0): Promise<ShopContext> {
    wire();
    const session = await deps.getSession();
    if (!session) throw new Error('Sign in to continue.');
    const userId = session.user.id;
    if (stored && stored.userId === userId && deps.now() - stored.at < CONTEXT_TTL_MS) {
      return stored.value;
    }
    if (inflight && inflight.userId === userId && inflight.generation === generation) {
      return recover(inflight.promise, attempt);
    }
    const startedIn = generation;
    const promise = (async () => {
      const [membership, shopId] = await Promise.all([
        deps.getMembership(),
        deps.getDefaultShopId(),
      ]);
      if (!membership) throw new Error('No tenant membership.');
      if (startedIn !== generation) throw new StaleRead();
      const value = { session, membership, shopId };
      stored = { userId, at: deps.now(), value };
      return value;
    })();
    inflight = { userId, generation: startedIn, promise };
    try {
      return await recover(promise, attempt);
    } finally {
      if (inflight?.promise === promise) inflight = null;
    }
  }

  // An invalidation (focus, reconnect, auth event) landed mid-read: never return that answer, ask again.
  async function recover(promise: Promise<ShopContext>, attempt: number): Promise<ShopContext> {
    try {
      return await promise;
    } catch (error) {
      if (!(error instanceof StaleRead)) throw error;
      if (attempt < 2) return get(attempt + 1);
      throw new Error('Your session changed while loading; retry.', { cause: error });
    }
  }

  async function businessDate(shopId: string): Promise<string> {
    const hit = dates.get(shopId);
    if (hit && hit.generation === generation && deps.now() - hit.at < DATE_TTL_MS) return hit.value;
    const startedIn = generation;
    const value = await deps.getBusinessDate(shopId);
    if (startedIn === generation) dates.set(shopId, { at: deps.now(), generation, value });
    return value;
  }

  return { get, businessDate, invalidate };
}

export const shopContext = createShopContext({
  now: () => Date.now(),
  getSession,
  getMembership: getCurrentMembership,
  getDefaultShopId,
  getBusinessDate: getShopBusinessDate,
  onAuthChange: onAuthStateChange,
});
