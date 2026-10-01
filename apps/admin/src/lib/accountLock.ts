// Serializes "check for an unresolved payment, then create and send a new one" for one account across
// every window of this browser (Web Locks API). Without it, two windows could both pass the check
// and each record the same money under a different request id (V2 residual).
//
// `contended` is true when another window held the lock while this one waited. That window may just
// have recorded (and even confirmed) a payment for the same account, which no open-attempt check can
// see any more, so callers must stop and let the user look before sending (V3, Codex P1).
// Where Web Locks is unavailable the check still runs, unserialized, as before.
type LockManagerLike = {
  request<T>(
    name: string,
    options: { mode: 'exclusive'; ifAvailable?: boolean },
    fn: (lock: unknown) => Promise<T>,
  ): Promise<T>;
};

export class AccountBusyError extends Error {}

export function withAccountLock<T>(
  shopId: string,
  accountId: string,
  fn: () => Promise<T>,
): Promise<T> {
  const locks = (globalThis.navigator as { locks?: LockManagerLike } | undefined)?.locks;
  if (!locks?.request) return fn();
  const name = `dsb-financial:${shopId}:${accountId}`;
  return locks.request(name, { mode: 'exclusive', ifAvailable: true }, async (lock) => {
    if (lock) return fn();
    // Another window is recording a payment for this account: wait for it to settle, then refuse.
    await locks.request(name, { mode: 'exclusive' }, async () => undefined);
    throw new AccountBusyError(
      'Another window just recorded a payment for this account. Nothing was sent — check the ledger, then submit again only if this is a separate payment.',
    );
  });
}
