import { describe, expect, it } from 'vitest';
import { AccountBusyError, withAccountLock } from './accountLock';

describe('withAccountLock', () => {
  it('runs the work directly where Web Locks is unavailable', async () => {
    await expect(withAccountLock('s', 'a', async () => 7)).resolves.toBe(7);
  });
  it('refuses a submission that had to wait for another window on the same account', async () => {
    // Minimal Web Locks fake: one holder per name, ifAvailable returns null when held.
    const held = new Map<string, Promise<void>>();
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: {
        locks: {
          async request<T>(
            name: string,
            o: { ifAvailable?: boolean },
            fn: (l: unknown) => Promise<T>,
          ): Promise<T> {
            if (held.has(name) && o.ifAvailable) return fn(null);
            while (held.has(name)) await held.get(name);
            let done: () => void = () => undefined;
            held.set(name, new Promise<void>((r) => (done = r)));
            try {
              return await fn({ name });
            } finally {
              held.delete(name);
              done();
            }
          },
        },
      },
    });
    let sent = 0;
    const first = withAccountLock('s', 'a', async () => {
      await new Promise((r) => setTimeout(r, 10));
      sent++;
      return 'committed';
    });
    const second = withAccountLock('s', 'a', async () => {
      sent++;
      return 'committed';
    });
    await expect(first).resolves.toBe('committed');
    await expect(second).rejects.toBeInstanceOf(AccountBusyError);
    expect(sent).toBe(1);
    // With the other window done, a deliberate resubmission goes through.
    await expect(withAccountLock('s', 'a', async () => 'again')).resolves.toBe('again');
    // Other accounts are independent.
    await expect(withAccountLock('s', 'b', async () => 'other')).resolves.toBe('other');
  });
});
