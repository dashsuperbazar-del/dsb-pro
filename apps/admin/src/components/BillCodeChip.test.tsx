// @vitest-environment jsdom
import { afterEach, expect, test, vi } from 'vitest';
import { render } from 'preact';
import { act } from 'preact/test-utils';
import { BillCodeChip } from './BillCodeChip';

const host = document.createElement('div');
afterEach(() => {
  act(() => render(null, host));
  vi.restoreAllMocks();
});

test('shows nothing for a bill without a code', () => {
  act(() => render(<BillCodeChip code={null} />, host));
  expect(host.innerHTML).toBe('');
  act(() => render(<BillCodeChip code={undefined} />, host));
  expect(host.innerHTML).toBe('');
});

test('tap copies the code and says so; a failed copy says so too', async () => {
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
  act(() => render(<BillCodeChip code="K7M2-QX9P" />, host));
  expect(host.textContent).toContain('K7M2-QX9P');
  await act(async () => host.querySelector('button')!.click());
  expect(writeText).toHaveBeenCalledWith('K7M2-QX9P');
  expect(host.textContent).toContain('Copied');
  writeText.mockRejectedValue(new Error('denied'));
  await act(async () => host.querySelector('button')!.click());
  expect(host.textContent).toContain('Could not copy');
});

test('a code is rendered as text, never as markup', () => {
  act(() => render(<BillCodeChip code={'<img src=x onerror=alert(1)>'} />, host));
  expect(host.querySelector('img')).toBeNull();
  expect(host.textContent).toContain('<img');
});
