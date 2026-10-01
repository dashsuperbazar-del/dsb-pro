// Serializes "check for an unresolved payment, then create and send a new one" for one account across
// every window of this browser (Web Locks API). Without it, two windows could both pass the check
// and each record the same receipt under a different request id (V2 residual).
// Where Web Locks is unavailable the check still runs, unserialized, as before.
type LockManagerLike = {
  request<T>(name: string, options: { mode: 'exclusive' }, fn: () => Promise<T>): Promise<T>;
};

export function withAccountLock<T>(
  shopId: string,
  accountId: string,
  fn: () => Promise<T>,
): Promise<T> {
  const locks = (globalThis.navigator as { locks?: LockManagerLike } | undefined)?.locks;
  if (!locks?.request) return fn();
  return locks.request(`dsb-financial:${shopId}:${accountId}`, { mode: 'exclusive' }, fn);
}
