// @vitest-environment jsdom
import { beforeEach, expect, test } from 'vitest';
import { defaultCostMode, rememberCostMode } from './costModePref';
import { emptyCard } from './billCards';

beforeEach(() => {
  delete (globalThis as { __dsbTestCostMode?: string }).__dsbTestCostMode;
  localStorage.removeItem('dsb:bill-cost-mode');
});

test('a new bill row starts on Total; a tap on Per unit is remembered on the device', () => {
  expect(defaultCostMode()).toBe('total');
  expect(emptyCard().costMode).toBe('total');
  rememberCostMode('unit');
  expect(emptyCard().costMode).toBe('unit');
  rememberCostMode('total');
  expect(defaultCostMode()).toBe('total');
});
