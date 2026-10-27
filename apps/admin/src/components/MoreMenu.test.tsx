// @vitest-environment jsdom
import { render } from 'preact';
import { act } from 'preact/test-utils';
import { afterEach, expect, it, vi } from 'vitest';
import { MoreMenu } from './MoreMenu';
import { rupees } from '../lib/money';

let host: HTMLElement;
afterEach(() => {
  render(null, host);
  host.remove();
});

it('opens on the button, exposes menu semantics, runs a choice and closes', () => {
  const pick = vi.fn();
  host = document.createElement('div');
  document.body.append(host);
  act(() =>
    render(
      <MoreMenu
        label="More actions for INV-1"
        items={[
          { label: 'Print', onSelect: () => undefined },
          { label: 'Void', danger: true, onSelect: pick },
        ]}
      />,
      host,
    ),
  );
  const button = host.querySelector('button')!;
  expect(button.getAttribute('aria-haspopup')).toBe('menu');
  expect(button.getAttribute('aria-expanded')).toBe('false');
  expect(host.querySelector('[role="menu"]')).toBeNull();
  act(() => button.click());
  expect(button.getAttribute('aria-expanded')).toBe('true');
  const items = [...host.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')];
  expect(items.map((i) => i.textContent)).toEqual(['Print', 'Void']);
  expect(items[1]!.className).toContain('danger');
  act(() => items[1]!.click());
  expect(pick).toHaveBeenCalledTimes(1);
  expect(host.querySelector('[role="menu"]')).toBeNull();
});

it('never shows a negative zero', () => {
  expect(rupees(-0)).toBe('₹0.00');
  expect(rupees('-0')).toBe('₹0.00');
  expect(rupees('-000')).toBe('₹0.00');
  expect(rupees(-264700)).toBe('−₹2,647.00');
});
