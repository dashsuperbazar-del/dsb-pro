import { expect, test } from 'vitest';
import { savedAgo } from './savedAge';

test('says how old a saved copy is, and never guesses an unknown time', () => {
  const now = Date.parse('2026-10-25T12:00:00Z');
  expect(savedAgo('2026-10-25T11:59:40Z', now)).toBe('saved just now');
  expect(savedAgo('2026-10-25T11:59:00Z', now)).toBe('saved 1 minute ago');
  expect(savedAgo('2026-10-25T11:15:00Z', now)).toBe('saved 45 minutes ago');
  expect(savedAgo('2026-10-25T09:00:00Z', now)).toBe('saved 3 hours ago');
  expect(savedAgo('2026-10-23T11:00:00Z', now)).toBe('saved 2 days ago');
  expect(savedAgo('2026-10-25T12:05:00Z', now)).toBe('saved just now');
  expect(savedAgo(null, now)).toBe('saved at an unknown time');
  expect(savedAgo('garbage', now)).toBe('saved at an unknown time');
});
