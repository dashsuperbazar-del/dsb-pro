import { describe, expect, it } from 'vitest';
import { parseScheduleForm, summarizeDue } from './supplierSchedule';

const f = (dueDay: string, amount = '', note = '') => ({ dueDay, amount, note });

describe('parseScheduleForm', () => {
  it('accepts a day with no amount', () => {
    expect(parseScheduleForm(f('5'))).toEqual({
      ok: true,
      dueDay: 5,
      expectedAmountPaise: null,
      note: '',
    });
  });
  it('turns rupees into exact paise', () => {
    expect(parseScheduleForm(f('28', '2500.50', ' rent '))).toMatchObject({
      expectedAmountPaise: '250050',
      note: 'rent',
    });
  });
  it('refuses a day outside 1-28 and a non-number', () => {
    for (const d of ['0', '29', '', 'x', '1.5', '-1'])
      expect(parseScheduleForm(f(d)).ok).toBe(false);
  });
  it('refuses amounts that would be rounded, zero or malformed', () => {
    for (const a of ['10.001', '0', '0.00', '-5', '1e3', 'abc', '1,000'])
      expect(parseScheduleForm(f('5', a)).ok).toBe(false);
  });
  it('refuses an over-long note', () => {
    expect(parseScheduleForm(f('5', '', 'x'.repeat(301))).ok).toBe(false);
  });
});

describe('summarizeDue', () => {
  const row = (remainingPaise: string | null) => ({ remainingPaise }) as never;
  it('sums remaining exactly and counts unknown amounts separately', () => {
    const s = summarizeDue([row('9007199254740993'), row('7'), row(null)]);
    expect(s.remainingPaise).toBe('9007199254741000');
    expect(s.openAmountCount).toBe(1);
    expect(s.count).toBe(3);
  });
});
