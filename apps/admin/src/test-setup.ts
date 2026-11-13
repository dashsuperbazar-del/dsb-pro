import { beforeEach } from 'vitest';

// Unit tests were written for the per-unit cost entry: a test-only flag pins it (no storage is touched).
// The Total default and the remembered choice have their own test (costModePref.test.ts).
beforeEach(() => {
  (globalThis as { __dsbTestCostMode?: string }).__dsbTestCostMode = 'unit';
});
