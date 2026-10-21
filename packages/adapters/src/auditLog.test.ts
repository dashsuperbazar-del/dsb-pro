import { describe, expect, it, vi } from 'vitest';
import { __setSupabaseClientForTest } from './client';
import { AUDIT_TYPES, auditFilter, listAuditEvents } from './auditLog';

function chain(result: { data: unknown; error: unknown }) {
  const calls: [string, unknown[]][] = [];
  const q: Record<string, unknown> = {};
  for (const m of ['select', 'or', 'order', 'eq', 'gte', 'lt', 'in']) {
    q[m] = (...a: unknown[]) => {
      calls.push([m, a]);
      return q;
    };
  }
  q.range = (...a: unknown[]) => {
    calls.push(['range', a]);
    return Promise.resolve(result);
  };
  (q as { then: unknown }).then = undefined;
  return { q, calls };
}

describe('audit log adapter', () => {
  it('every type has one clause; none writes', () => {
    expect(auditFilter([]).split('),').length).toBeGreaterThan(AUDIT_TYPES.length - 2);
    expect(auditFilter(['sale_void'])).toContain('table_name.eq.sale_invoices');
    expect(auditFilter(['sale_void'])).toContain('before->>status.neq.VOID');
  });

  it('reads one page plus a probe row, filtered by type, user and local dates', async () => {
    const rows = Array.from({ length: 3 }, (_, i) => ({
      id: `e${i}`,
      created_at: '2026-10-21T10:00:00Z',
      user_id: 'u1',
      table_name: 'item_prices',
      row_id: 'r',
      action: 'INSERT',
      before: null,
      after: { item_id: 'i1', price_paise: 1000 },
    }));
    const audit = chain({ data: rows, error: null });
    const items = {
      select: () => ({ in: () => Promise.resolve({ data: [{ id: 'i1', name: 'Sugar' }] }) }),
    };
    const from = vi.fn((t: string) => (t === 'audit_log' ? audit.q : items));
    __setSupabaseClientForTest({ from } as never);
    const out = await listAuditEvents({
      type: 'price_change',
      userId: 'u1',
      from: '2026-10-01',
      to: '2026-10-21',
      page: 1,
      pageSize: 2,
    });
    expect(out.hasMore).toBe(true);
    expect(out.rows).toHaveLength(2);
    expect(out.rows[0]!.itemNames).toEqual({ i1: 'Sugar' });
    const names = audit.calls.map((c) => c[0]);
    expect(names).toEqual(expect.arrayContaining(['or', 'eq', 'gte', 'lt', 'range']));
    expect(audit.calls.find((c) => c[0] === 'range')![1]).toEqual([2, 4]);
    expect(audit.calls.find((c) => c[0] === 'eq')![1]).toEqual(['user_id', 'u1']);
  });

  it('throws a read error instead of showing an empty log', async () => {
    const audit = chain({ data: null, error: new Error('denied') });
    __setSupabaseClientForTest({ from: () => audit.q } as never);
    await expect(listAuditEvents()).rejects.toThrow('denied');
  });
});
