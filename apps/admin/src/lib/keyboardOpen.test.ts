// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { isTypingTarget } from './keyboardOpen';

describe('isTypingTarget', () => {
  it('text-like inputs and textareas open the keyboard', () => {
    const i = document.createElement('input');
    expect(isTypingTarget(i)).toBe(true);
    i.type = 'number';
    expect(isTypingTarget(i)).toBe(true);
    expect(isTypingTarget(document.createElement('textarea'))).toBe(true);
  });
  it('buttons, checkboxes, read-only fields and nothing do not', () => {
    const c = document.createElement('input');
    c.type = 'checkbox';
    expect(isTypingTarget(c)).toBe(false);
    const r = document.createElement('input');
    r.readOnly = true;
    expect(isTypingTarget(r)).toBe(false);
    expect(isTypingTarget(document.createElement('button'))).toBe(false);
    expect(isTypingTarget(null)).toBe(false);
  });
});
