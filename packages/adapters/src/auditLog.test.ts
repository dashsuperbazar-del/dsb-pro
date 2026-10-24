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
    const from = vi.fn((t: string) => (t === 'audit_feed' ? audit.q : items));
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

  it('marks the void a bill edit made (bill now replaced), not a plain void', async () => {
    const row = (id: string, rowId: string) => ({
      id,
      created_at: '2026-10-21T10:00:00Z',
      user_id: 'u1',
      table_name: 'purchase_bills',
      row_id: rowId,
      action: 'UPDATE',
      before: { status: 'POSTED' },
      after: { status: 'VOID', replaced_by_id: null },
    });
    const audit = chain({ data: [row('e1', 'b-edited'), row('e2', 'b-plain')], error: null });
    const asked: unknown[] = [];
    const bills = {
      select: () => ({
        in: (_c: string, ids: unknown) => {
          asked.push(ids);
          return Promise.resolve({
            data: [
              { id: 'b-edited', replaced_by_id: 'b-new' },
              { id: 'b-plain', replaced_by_id: null },
            ],
          });
        },
      }),
    };
    __setSupabaseClientForTest({
      from: (t: string) => (t === 'audit_feed' ? audit.q : bills),
    } as never);
    const out = await listAuditEvents({ type: 'purchase_void' });
    expect(asked).toEqual([['b-edited', 'b-plain']]);
    expect(out.rows.map((r) => r.voidByEdit)).toEqual([true, false]);
  });

  it('a failed link read leaves voids as plain voids', async () => {
    const audit = chain({
      data: [
        {
          id: 'e1',
          created_at: '2026-10-21T10:00:00Z',
          user_id: 'u1',
          table_name: 'purchase_bills',
          row_id: 'b1',
          action: 'UPDATE',
          before: { status: 'POSTED' },
          after: { status: 'VOID' },
        },
      ],
      error: null,
    });
    const bills = { select: () => ({ in: () => Promise.reject(new Error('offline')) }) };
    __setSupabaseClientForTest({
      from: (t: string) => (t === 'audit_feed' ? audit.q : bills),
    } as never);
    const out = await listAuditEvents();
    expect(out.rows).toHaveLength(1);
    expect(out.rows[0]!.voidByEdit).toBe(false);
  });

  it('reads the feed; before 0070 is live it falls back to audit_log without remark history', async () => {
    const missing = chain({
      data: null,
      error: { code: 'PGRST205', message: "Could not find the table 'public.audit_feed'" },
    });
    const plain = chain({ data: [], error: null });
    const from = vi.fn((t: string) => (t === 'audit_feed' ? missing.q : plain.q));
    __setSupabaseClientForTest({ from } as never);
    const out = await listAuditEvents();
    expect(out.rows).toEqual([]);
    expect(from.mock.calls.map((c) => c[0])).toEqual(['audit_feed', 'audit_log']);
    const filter = String(plain.calls.find((c) => c[0] === 'or')![1][0]);
    expect(filter).not.toContain('document_remark_events');
    expect(filter).toContain('price_source.eq.manual');
    // Remark history alone has nothing to show before the feed exists (no error, no rows).
    __setSupabaseClientForTest({
      from: vi.fn(
        () => chain({ data: null, error: { code: '42P01', message: 'relation does not exist' } }).q,
      ),
    } as never);
    expect(await listAuditEvents({ type: 'remark' })).toEqual({ hasMore: false, rows: [] });
  });

  it('does not fall back on a permission error: it is shown, never a silently smaller log', async () => {
    const denied = chain({
      data: null,
      error: { code: '42501', message: 'permission denied for view audit_feed' },
    });
    __setSupabaseClientForTest({ from: () => denied.q } as never);
    await expect(listAuditEvents()).rejects.toMatchObject({ code: '42501' });
  });

  it('labels typed-price lines and remarks with their invoice or bill', async () => {
    const feed = chain({
      data: [
        {
          id: 'e1',
          created_at: '2026-10-22T10:00:00Z',
          user_id: 'u1',
          table_name: 'sale_invoice_items',
          row_id: 'l1',
          action: 'INSERT',
          before: null,
          after: { sale_invoice_id: 's1', price_source: 'manual', line_kind: 'free_text' },
        },
        {
          id: 'e2',
          created_at: '2026-10-22T10:00:00Z',
          user_id: 'u1',
          table_name: 'document_remark_events',
          row_id: 'm1',
          action: 'INSERT',
          before: null,
          after: { purchase_bill_id: 'b1', remark_action: 'ADD', body: 'x' },
        },
      ],
      error: null,
    });
    const lookup = (rows: unknown[]) => ({
      select: () => ({ in: () => Promise.resolve({ data: rows }) }),
    });
    __setSupabaseClientForTest({
      from: (t: string) =>
        t === 'audit_feed'
          ? feed.q
          : t === 'sale_invoices'
            ? lookup([{ id: 's1', doc_no: 'INV-000007' }])
            : lookup([{ id: 'b1', bill_no: 'A-12', replaced_by_id: null }]),
    } as never);
    const out = await listAuditEvents();
    expect(out.rows[0]!.docLabels).toEqual({ s1: 'sale INV-000007', b1: 'purchase bill A-12' });
  });

  it('throws a read error instead of showing an empty log', async () => {
    const audit = chain({ data: null, error: new Error('denied') });
    __setSupabaseClientForTest({ from: () => audit.q } as never);
    await expect(listAuditEvents()).rejects.toThrow('denied');
  });
});
