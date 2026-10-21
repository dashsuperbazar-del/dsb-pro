import { expect, test } from 'vitest';
import type { AuditEvent } from '@dsb-pro/adapters';
import { auditType, changedFields, describeAudit } from './auditLog';

const base: AuditEvent = {
  id: 'e',
  createdAt: '2026-10-21T10:00:00Z',
  userId: 'u1',
  tableName: 'sale_invoices',
  rowId: 'r',
  action: 'UPDATE',
  before: null,
  after: null,
  itemNames: {},
};
const who = (id: string | null) => (id === 'u1' ? 'Asha' : id ? 'someone' : 'the system');

test('a sale void is the status transition only', () => {
  const voided = {
    ...base,
    before: { status: 'FINAL', doc_no: 'INV-1', total_paise: 12550 },
    after: { status: 'VOID', doc_no: 'INV-1', total_paise: 12550 },
  };
  expect(auditType(voided)).toBe('sale_void');
  expect(describeAudit(voided, who)).toBe('Sale INV-1 voided (₹125.50).');
  expect(auditType({ ...voided, before: voided.after })).toBeNull();
});

test('a credit-limit override names who allowed it and the stored snapshots', () => {
  const e: AuditEvent = {
    ...base,
    action: 'INSERT',
    after: {
      doc_no: 'INV-2',
      total_paise: 50000,
      credit_override_by: 'u1',
      credit_limit_snapshot_paise: 100000,
      credit_outstanding_snapshot_paise: 90000,
    },
  };
  expect(auditType(e)).toBe('credit_override');
  expect(describeAudit(e, who)).toBe(
    'Sale INV-2 (₹500.00) went over the credit limit and was allowed by Asha. Limit ₹1,000.00, owed before ₹900.00.',
  );
});

test('a purchase bill edit is told apart from a plain void', () => {
  const edit: AuditEvent = {
    ...base,
    tableName: 'purchase_bills',
    before: { status: 'POSTED', replaced_by_id: null, bill_no: 'B7', total_paise: 1000 },
    after: { status: 'VOID', replaced_by_id: 'new', bill_no: 'B7', total_paise: 1000 },
  };
  expect(auditType(edit)).toBe('bill_edit');
  expect(describeAudit(edit, who)).toContain('replaced by a corrected bill');
  const plain = { ...edit, after: { ...edit.after, replaced_by_id: null } };
  expect(auditType(plain)).toBe('purchase_void');
});

test('a price row shows the item name and the earlier price', () => {
  const e: AuditEvent = {
    ...base,
    tableName: 'item_prices',
    before: { price_paise: 4000 },
    after: { item_id: 'i1', kind: 'retail', unit_level: 1, price_paise: 4500 },
    itemNames: { i1: 'Sugar' },
  };
  expect(describeAudit(e, who)).toBe('Sugar: retail price set to ₹45.00 for unit 1 (was ₹40.00).');
});

test('changed fields list money and GST in readable form and cap the count', () => {
  expect(
    changedFields(
      { credit_limit_paise: 500000, tax_rate_bp: 500, updated_at: 1 },
      { credit_limit_paise: 800000, tax_rate_bp: 1200, updated_at: 2 },
    ),
  ).toBe('credit limit ₹5,000.00 → ₹8,000.00, GST rate 5% → 12%');
  const many = Object.fromEntries(Array.from({ length: 6 }, (_, i) => [`f${i}`, i]));
  const other = Object.fromEntries(Array.from({ length: 6 }, (_, i) => [`f${i}`, i + 1]));
  expect(changedFields(many, other)).toMatch(/and 2 more$/);
});

test('markup in stored text is returned as plain text (the screen escapes at render)', () => {
  const e = {
    ...base,
    tableName: 'customers',
    before: { name: '<b>x</b>' },
    after: { name: '<img src=x onerror=alert(1)>' },
  };
  expect(describeAudit(e, who)).toContain('<img src=x onerror=alert(1)>');
});
