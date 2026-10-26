import { describe, expect, it } from 'vitest';
import { friendlyError } from './friendlyError';

describe('friendlyError', () => {
  it('maps a known server code to plain wording and keeps the code for support', () => {
    const out = friendlyError(
      new Error('DSB_TOTAL_MISMATCH: server total 12000 differs from 11900'),
    );
    expect(out.code).toBe('DSB_TOTAL_MISMATCH');
    expect(out.text).toMatch(/total changed/i);
    expect(out.text).not.toMatch(/DSB_|12000/);
  });
  it('strips repeated Error: prefixes and keeps the sentence of an unlisted code', () => {
    const out = friendlyError('Error: Error: DSB_SOMETHING_NEW: that did not work');
    expect(out).toEqual({ text: 'that did not work', code: 'DSB_SOMETHING_NEW' });
  });
  it('adds the next step to the known server sentences', () => {
    expect(friendlyError('Walk-in sale must be fully paid.').text).toMatch(
      /^Walk-in sale must be fully paid\. Enter the full amount/,
    );
    expect(friendlyError('Payments exceed sale total.').text).toMatch(
      /^Payments exceed sale total\. Lower the amount/,
    );
    expect(friendlyError('Payments exceed sale total.').code).toBeNull();
  });
  it('leaves any other message as it is and never returns an empty text', () => {
    expect(friendlyError('Barcode not found.').text).toBe('Barcode not found.');
    expect(friendlyError({ message: 'Barcode item is unavailable.' }).text).toBe(
      'Barcode item is unavailable.',
    );
    expect(friendlyError('').text).not.toBe('');
  });
});
