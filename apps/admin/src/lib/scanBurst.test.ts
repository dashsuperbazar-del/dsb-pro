// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createBurstDetector, isScanTarget, type BurstKey } from './scanBurst';

const field = {};
const other = {};
const k = (key: string, extra: Partial<BurstKey> = {}): BurstKey => ({ key, ...extra });
function type(
  d: ReturnType<typeof createBurstDetector>,
  text: string,
  gap: number,
  f: unknown = field,
) {
  for (const ch of text) {
    expect(d.onKey(k(ch), f)).toBeNull();
    vi.advanceTimersByTime(gap);
  }
}
beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('burst detector', () => {
  it('a fast burst of 6+ chars ending in Enter is a scan', () => {
    const d = createBurstDetector();
    type(d, '8901234', 5);
    expect(d.onKey(k('Enter'), field)).toBe('8901234');
  });
  it('exactly 6 chars counts; 5 does not', () => {
    const d = createBurstDetector();
    type(d, 'ABC123', 10);
    expect(d.onKey(k('Enter'), field)).toBe('ABC123');
    type(d, 'ABC12', 10);
    expect(d.onKey(k('Enter'), field)).toBeNull();
  });
  it('slow human typing (120 ms gaps) is never a scan', () => {
    const d = createBurstDetector();
    type(d, '8901234', 120);
    expect(d.onKey(k('Enter'), field)).toBeNull();
  });
  it('a gap of 100 ms or more breaks the burst; only the fast tail counts', () => {
    const d = createBurstDetector();
    type(d, 'abc', 10);
    vi.advanceTimersByTime(150);
    type(d, 'defg', 10);
    expect(d.onKey(k('Enter'), field)).toBeNull(); // the fast tail is only 4 chars
    type(d, 'abc', 10);
    vi.advanceTimersByTime(150);
    type(d, 'defghi', 10);
    expect(d.onKey(k('Enter'), field)).toBe('defghi');
  });
  it('one stretched gap (a busy page) is tolerated while the average stays fast', () => {
    const d = createBurstDetector();
    type(d, 'abc', 10);
    vi.advanceTimersByTime(60);
    type(d, 'defg', 10);
    expect(d.onKey(k('Enter'), field)).toBe('abcdefg');
  });
  it('typing that averages 60 ms a key is a person, even without a long pause', () => {
    const d = createBurstDetector();
    type(d, '8901234', 60);
    expect(d.onKey(k('Enter'), field)).toBeNull();
  });
  it('a pause before the closing Enter means a person typed it', () => {
    const d = createBurstDetector();
    type(d, '8901234', 5);
    vi.advanceTimersByTime(200);
    expect(d.onKey(k('Enter'), field)).toBeNull();
  });
  it('Enter alone, or a second Enter, is not a scan', () => {
    const d = createBurstDetector();
    expect(d.onKey(k('Enter'), field)).toBeNull();
    type(d, '8901234', 5);
    expect(d.onKey(k('Enter'), field)).toBe('8901234');
    expect(d.onKey(k('Enter'), field)).toBeNull();
  });
  it('a non-character key, a modifier chord, a held key or a change of field starts over', () => {
    const d = createBurstDetector();
    type(d, 'abcd', 5);
    expect(d.onKey(k('Backspace'), field)).toBeNull();
    type(d, 'ef', 5);
    expect(d.onKey(k('Enter'), field)).toBeNull();
    type(d, 'abcd', 5);
    expect(d.onKey(k('v', { ctrlKey: true }), field)).toBeNull();
    type(d, 'ef', 5);
    expect(d.onKey(k('Enter'), field)).toBeNull();
    type(d, 'abcdef', 5);
    expect(d.onKey(k('Enter'), other)).toBeNull();
    type(d, 'abcde', 5);
    expect(d.onKey(k('a', { repeat: true }), field)).toBeNull();
    expect(d.onKey(k('Enter'), field)).toBeNull();
    type(d, 'abcdef', 5);
    expect(d.onKey(k('Enter', { repeat: true }), field)).toBeNull();
  });
});

describe('burst detector uses the key time, not when the page got round to it', () => {
  it('keys received 5 ms apart but handled late (busy page) still form a burst', () => {
    const d = createBurstDetector();
    let at = 1000;
    for (const ch of '8901234') {
      vi.advanceTimersByTime(80); // the page is slow to run the handler
      expect(d.onKey(k(ch, { timeStamp: (at += 5) }), field)).toBeNull();
    }
    expect(d.onKey(k('Enter', { timeStamp: at + 5 }), field)).toBe('8901234');
  });
  it('keys received 120 ms apart are slow even if handled together', () => {
    const d = createBurstDetector();
    let at = 1000;
    for (const ch of '8901234') d.onKey(k(ch, { timeStamp: (at += 120) }), field);
    expect(d.onKey(k('Enter', { timeStamp: at + 5 }), field)).toBeNull();
  });
});

describe('capital letters', () => {
  it('a Shift key between the characters does not break a burst', () => {
    const d = createBurstDetector();
    for (const ch of 'ZZZ9999') {
      expect(d.onKey(k('Shift'), field)).toBeNull();
      expect(d.onKey(k(ch), field)).toBeNull();
      vi.advanceTimersByTime(5);
    }
    expect(d.onKey(k('Enter'), field)).toBe('ZZZ9999');
  });
});

describe('isScanTarget', () => {
  const input = (attrs: Record<string, string>) => {
    const el = document.createElement('input');
    for (const [a, v] of Object.entries(attrs)) el.setAttribute(a, v);
    return el;
  };
  it('accepts text-like fields', () => {
    expect(isScanTarget(input({}))).toBe(true);
    expect(isScanTarget(input({ type: 'text' }))).toBe(true);
    expect(isScanTarget(input({ type: 'search' }))).toBe(true);
  });
  it('refuses numeric qty/price fields, checkboxes, passwords, areas and non-inputs', () => {
    expect(isScanTarget(input({ type: 'number', inputmode: 'decimal' }))).toBe(false);
    expect(isScanTarget(input({ inputmode: 'decimal' }))).toBe(false);
    expect(isScanTarget(input({ type: 'checkbox' }))).toBe(false);
    expect(isScanTarget(input({ type: 'password' }))).toBe(false);
    expect(isScanTarget(document.createElement('textarea'))).toBe(false);
    expect(isScanTarget(document.body)).toBe(false);
  });
});
