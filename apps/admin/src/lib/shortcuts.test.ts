// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { isTypingField, posShortcut, stepIndex } from './shortcuts';

describe('posShortcut', () => {
  it('maps the documented keys', () => {
    expect(posShortcut({ key: 'F2' })).toBe('customer');
    expect(posShortcut({ key: 'F3' })).toBe('find');
    expect(posShortcut({ key: 'F4' })).toBe('payment');
    expect(posShortcut({ key: 'Escape' })).toBe('cancel');
    expect(posShortcut({ key: 'Enter', ctrlKey: true })).toBe('finalize');
  });
  it('ignores plain Enter, other Ctrl keys, modified F-keys and IME composition', () => {
    expect(posShortcut({ key: 'Enter' })).toBeNull();
    expect(posShortcut({ key: 'F4', altKey: true })).toBeNull();
    expect(posShortcut({ key: 'F2', ctrlKey: true })).toBeNull();
    expect(posShortcut({ key: 'F2', metaKey: true })).toBeNull();
    expect(posShortcut({ key: 'Escape', isComposing: true })).toBeNull();
    expect(posShortcut({ key: 'Enter', ctrlKey: true, defaultPrevented: true })).toBeNull();
  });
});

describe('isTypingField', () => {
  it('is true for text inputs and textareas only', () => {
    const input = document.createElement('input');
    expect(isTypingField(input)).toBe(true);
    input.type = 'number';
    expect(isTypingField(input)).toBe(true);
    input.type = 'checkbox';
    expect(isTypingField(input)).toBe(false);
    expect(isTypingField(document.createElement('textarea'))).toBe(true);
    expect(isTypingField(document.createElement('select'))).toBe(false);
    expect(isTypingField(document.createElement('button'))).toBe(false);
    expect(isTypingField(null)).toBe(false);
  });
});

describe('stepIndex', () => {
  it('clamps at both ends and starts from the right edge', () => {
    expect(stepIndex(-1, 3, 'ArrowDown')).toBe(0);
    expect(stepIndex(-1, 3, 'ArrowUp')).toBe(2);
    expect(stepIndex(2, 3, 'ArrowDown')).toBe(2);
    expect(stepIndex(0, 3, 'ArrowUp')).toBe(0);
    expect(stepIndex(1, 3, 'ArrowDown')).toBe(2);
    expect(stepIndex(0, 0, 'ArrowDown')).toBe(-1);
  });
});
