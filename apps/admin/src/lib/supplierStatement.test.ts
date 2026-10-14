import { expect, test } from 'vitest';
import {
  prepareSupplierStatement,
  statementCsv,
  statementHtml,
  statementText,
} from './supplierStatement';

const scope = { shopId: 'shop', partyId: 'supplier', from: '2026-10-01', to: '2026-10-14' };
const ledger = {
  ...scope,
  openingBalancePaise: '9007199254740993',
  closingBalancePaise: '9007199254740943',
  entries: [
    {
      id: 'payment',
      date: '2026-10-02',
      kind: 'PAYMENT_MADE',
      document: '=HYPERLINK("evil")',
      amountPaise: '-50',
      runningBalancePaise: '9007199254740943',
    },
  ],
};
const profile = {
  id: 'shop',
  name: '<img src=x onerror=alert(1)>',
  address: 'Market road',
  gstin: null,
};
const make = (data: unknown = ledger) =>
  prepareSupplierStatement(data, scope, profile, '@Supplier', '2026-10-14T00:00:00Z');

test('purchases, returns, both payment directions and signed openings preserve the server sequence', () => {
  const rows = [
    ['PURCHASE', '1000', '800'],
    ['PURCHASE_RETURN', '-100', '700'],
    ['PAYMENT_MADE', '-300', '400'],
    ['PAYMENT_RECEIVED', '100', '500'],
    ['OPENING_BALANCE', '-50', '450'],
  ].map(([kind, amountPaise, runningBalancePaise], i) => ({
    id: String(i),
    date: `2026-10-0${i + 1}`,
    kind,
    document: `Document ${i}`,
    amountPaise,
    runningBalancePaise,
  }));
  const s = make({
    ...ledger,
    openingBalancePaise: '-200',
    closingBalancePaise: '450',
    entries: rows,
  });
  expect(statementText(s)).toContain('Purchase return');
  expect(statementText(s)).toContain('Payment received');
  expect(statementText(s)).toContain('Closing: ₹4.50');
  expect(() =>
    make({
      ...ledger,
      openingBalancePaise: '-200',
      closingBalancePaise: '450',
      entries: rows.toReversed(),
    }),
  ).toThrow();
});

test('server balances above the safe integer limit stay exact in every output', () => {
  const s = make();
  expect(statementText(s)).toContain('₹9,00,71,99,25,47,409.43');
  expect(statementCsv(s)).toContain('90071992547409.43');
  expect(statementHtml(s, 'https://example.test/assets/statement.css')).toContain(
    '₹9,00,71,99,25,47,409.43',
  );
  expect(statementText(s)).toContain('Opening');
  expect(statementText(s)).toContain('Voids restate history');
});

test('wrong party/shop/date response and incomplete issuer fail closed', () => {
  for (const change of [{ partyId: 'other' }, { shopId: 'other' }, { from: null }, { to: null }]) {
    expect(() => make({ ...ledger, ...change })).toThrow();
  }
  expect(() =>
    prepareSupplierStatement(ledger, scope, { ...profile, id: 'other' }, 'S', 'now'),
  ).toThrow();
  expect(() =>
    prepareSupplierStatement(ledger, scope, { ...profile, name: '' }, 'S', 'now'),
  ).toThrow();
});

test('malformed, missing, rounded, duplicate or out-of-range rows cannot be exported', () => {
  for (const row of [
    null,
    { ...ledger.entries[0], amountPaise: -50 },
    { ...ledger.entries[0], runningBalancePaise: '9007199254740944' },
    { ...ledger.entries[0], date: '2026-09-30' },
    { ...ledger.entries[0], kind: 'UNRECOGNIZED' },
  ]) {
    expect(() => make({ ...ledger, entries: [row] })).toThrow();
  }
  expect(() => make({ ...ledger, entries: [] })).toThrow();
  expect(() => make({ ...ledger, entries: [...ledger.entries, ...ledger.entries] })).toThrow();
});

test('negative credit and an empty period keep the server opening/closing; outputs escape free text', () => {
  const s = make({
    ...ledger,
    openingBalancePaise: '-1200',
    closingBalancePaise: '-1200',
    entries: [],
  });
  expect(statementText(s)).toContain('−₹12.00');
  expect(statementHtml(s, 'https://example.test/assets/statement.css')).toContain(
    '&lt;img src=x onerror=alert(1)&gt;',
  );
  expect(statementHtml(s, 'https://example.test/assets/statement.css')).not.toContain('<img');
  expect(statementHtml(s, 'https://example.test/assets/statement.css')).toContain(
    'No posted entries in this period',
  );
  expect(statementCsv(s)).toContain("'@Supplier");
  expect(statementCsv(make())).toContain("'=HYPERLINK");
});

test('leap dates, bounds and chronological order are validated; the response is copied', () => {
  expect(() =>
    prepareSupplierStatement(ledger, { ...scope, from: '2026-02-30' }, profile, 'S', 'now'),
  ).toThrow();
  expect(() =>
    prepareSupplierStatement(ledger, { ...scope, from: '2026-10-15' }, profile, 'S', 'now'),
  ).toThrow();
  const source = structuredClone(ledger);
  const s = make(source);
  source.entries[0].document = 'changed';
  expect(statementText(s)).not.toContain('changed');
});
