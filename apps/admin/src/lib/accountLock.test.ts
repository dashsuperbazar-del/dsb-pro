import { describe, expect, it } from 'vitest';
import { withAccountLock } from './accountLock';

describe('withAccountLock', () => {
  it('runs the work directly where Web Locks is unavailable', async () => {
    await expect(withAccountLock('s', 'a', async () => 7)).resolves.toBe(7);
  });
  it('serializes work for the same account through navigator.locks', async () => {
    const order: string[] = [];
    let tail = Promise.resolve();
    const names: string[] = [];
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: {
        locks: {
          request: <T>(name: string, _o: unknown, fn: () => Promise<T>) => {
            names.push(name);
            const run = tail.then(fn);
            tail = run.then(
              () => undefined,
              () => undefined,
            );
            return run;
          },
        },
      },
    });
    const slow = withAccountLock('s', 'a', async () => {
      order.push('first-start');
      await new Promise((r) => setTimeout(r, 10));
      order.push('first-end');
    });
    const fast = withAccountLock('s', 'a', async () => {
      order.push('second');
    });
    await Promise.all([slow, fast]);
    expect(order).toEqual(['first-start', 'first-end', 'second']);
    expect(names).toEqual(['dsb-financial:s:a', 'dsb-financial:s:a']);
  });
});
