/**
 * Small LRU of recently opened details, for DISPLAY ONLY (instant reopen / hover prefetch). Callers must
 * still revalidate from the server and must invalidate on any write (void, post, payment). Failures are
 * never cached, and a read that started before an invalidate is discarded rather than stored.
 */
export function createDetailCache<V>(load: (key: string) => Promise<V>, max = 20) {
  const values = new Map<string, V>();
  const inflight = new Map<string, Promise<V>>();
  let epoch = 0;
  const keyEpoch = new Map<string, number>();
  const touch = (key: string, value: V) => {
    values.delete(key);
    values.set(key, value);
    while (values.size > max) values.delete(values.keys().next().value as string);
  };
  return {
    peek(key: string): V | undefined {
      const v = values.get(key);
      if (v !== undefined) touch(key, v);
      return v;
    },
    fetch(key: string, fresh = false): Promise<V> {
      const running = inflight.get(key);
      if (running && !fresh) return running;
      const started = keyEpoch.get(key) ?? epoch;
      const p = load(key)
        .then((v) => {
          if ((keyEpoch.get(key) ?? epoch) === started) touch(key, v);
          return v;
        })
        .finally(() => {
          if (inflight.get(key) === p) inflight.delete(key);
        });
      inflight.set(key, p);
      return p;
    },
    invalidate(key: string) {
      values.delete(key);
      inflight.delete(key);
      keyEpoch.set(key, ++epoch);
    },
    clear() {
      values.clear();
      inflight.clear();
      epoch++;
      for (const k of keyEpoch.keys()) keyEpoch.set(k, epoch);
    },
  };
}
