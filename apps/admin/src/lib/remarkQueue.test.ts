import { beforeEach, describe, expect, it } from 'vitest';
import { flushRemarkQueue, queueRemark, queuedRemarks, type QueuedRemark } from './remarkQueue';

const store = new Map<string, string>();
(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => store.set(k, v),
  removeItem: (k: string) => store.delete(k),
  get length() {
    return store.size;
  },
  key: (i: number) => [...store.keys()][i] ?? null,
};
beforeEach(() => store.clear());

const entry = (over: Partial<QueuedRemark> = {}): QueuedRemark => ({
  clientId: 'c1',
  userId: 'u1',
  shopId: 's1',
  docKind: 'purchase',
  docId: 'b1',
  body: '5 kg sugar short',
  queuedAt: 1,
  ...over,
});

describe('remark queue', () => {
  it('holds one entry per client id, even when two windows wrote the same add', () => {
    store.set(
      'dsb.remarkQueue.v1',
      JSON.stringify([entry(), entry({ lastError: 'x' }), entry({ clientId: 'c2' })]),
    );
    expect(queuedRemarks('u1').map((e) => e.clientId)).toEqual(['c1', 'c2']);
    expect(queuedRemarks('u1')[0]!.lastError).toBe('x');
  });

  it('re-queueing the same id replaces it', () => {
    queueRemark(entry());
    queueRemark(entry({ body: '5 kg sugar short' }));
    expect(queuedRemarks('u1', 'purchase', 'b1')).toHaveLength(1);
  });

  it('a duplicate stored entry is sent once and leaves on commit', async () => {
    store.set('dsb.remarkQueue.v1', JSON.stringify([entry(), entry()]));
    const sent: string[] = [];
    const out = await flushRemarkQueue('u1', async (e) => {
      sent.push(e.clientId);
      return { kind: 'committed', value: 'r1' };
    });
    expect(sent).toEqual(['c1']);
    expect(out.sent).toBe(1);
    expect(queuedRemarks('u1')).toHaveLength(0);
  });
});
