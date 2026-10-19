// @vitest-environment jsdom
import { afterEach, expect, test } from 'vitest';
import { render } from 'preact';
import { act } from 'preact/test-utils';
import { QuickEntry } from './QuickEntry';
import { appRoute } from '../lib/paths';

const host = document.createElement('div');
afterEach(() => {
  act(() => render(null, host));
});
const links = () => [
  ...host.querySelectorAll<HTMLAnchorElement>('nav[aria-label="Quick entry"] a'),
];

test('owner sees all four entries and only New sale is the filled primary action', () => {
  act(() => render(<QuickEntry role="owner" />, host));
  expect(links().map((a) => a.textContent)).toEqual([
    'Purchase',
    'Pay supplier',
    'New sale',
    'Stock',
  ]);
  const primary = links().filter((a) => a.classList.contains('quick-primary'));
  expect(primary.map((a) => a.textContent)).toEqual(['New sale']);
  expect(primary[0].getAttribute('href')).toBe(appRoute.pos);
});

test('cashier sees only New sale, still as the primary action', () => {
  act(() => render(<QuickEntry role="cashier" />, host));
  expect(links().map((a) => a.textContent)).toEqual(['New sale']);
  expect(links()[0].classList.contains('quick-primary')).toBe(true);
});
