import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { errorText } from './friendlyError';

// errorText turns a server code into a plain sentence and DROPS the code. Anything that decides what to do
// from the message (credit-limit panel, definitive-refusal id rotation, permanent price errors) must keep
// reading the RAW text; errorText is for what is shown only.
const read = (f: string) => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');

describe('raw error text stays raw where logic reads it', () => {
  it('errorText drops the code, so it can never feed a decision', () => {
    const raw = 'DSB_CREDIT_LIMIT_EXCEEDED: limit 5000';
    expect(/DSB_CREDIT_LIMIT_EXCEEDED/.test(raw)).toBe(true);
    expect(/DSB_CREDIT_LIMIT_EXCEEDED/.test(errorText(new Error(raw)))).toBe(false);
  });
  it('the POS screen decides on the raw message (credit-limit panel, client id rotation)', () => {
    const pos = read('screens/PosScreen.tsx');
    expect(pos).not.toMatch(/errorText/);
    expect(pos).toMatch(/DSB_CREDIT_LIMIT_EXCEEDED/);
    expect(pos).toMatch(/isDefinitiveFinancialRejectionMessage/);
  });
  it('the sale-price retry classifies the raw message and only shows the friendly one', () => {
    const inv = read('screens/InventoryScreen.tsx');
    expect(inv).toMatch(/isPermanentPriceError\(raw\)/);
    expect(inv).not.toMatch(/isPermanentPriceError\(message\)/);
  });
});
