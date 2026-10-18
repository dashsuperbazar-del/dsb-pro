// @vitest-environment jsdom
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { render } from 'preact';
import { act } from 'preact/test-utils';
vi.mock('@dsb-pro/adapters', () => ({ readBillDocument: vi.fn() }));
import { BillDocumentPreview } from './BillDocumentPreview';

const host = document.createElement('div');
beforeEach(() => {
  localStorage.clear();
  document.body.append(host);
  URL.createObjectURL = vi.fn(() => 'blob:x');
  URL.revokeObjectURL = vi.fn();
});
afterEach(async () => {
  await act(async () => render(null, host));
  host.remove();
});
const btn = (label: string) =>
  [...host.querySelectorAll('button')].find(
    (b) => b.textContent === label || b.getAttribute('aria-label') === label,
  )!;
const panelWidth = () =>
  (host.querySelector('[aria-label="Bill document viewer"]') as HTMLElement).style.width;

test('the viewer remembers its size for the next bill; bad stored geometry is ignored', async () => {
  const blob = new Blob(['x'], { type: 'image/webp' });
  await act(async () => render(<BillDocumentPreview blob={blob} />, host));
  await act(async () => btn('View bill document').click());
  await act(async () => btn('Make bill viewer smaller').click());
  expect(JSON.parse(localStorage.getItem('dsb-bill-peek-geom')!).w).toBe(360);
  await act(async () => btn('Close bill viewer').click());
  await act(async () => render(null, host));
  await act(async () => render(<BillDocumentPreview blob={blob} />, host));
  await act(async () => btn('View bill document').click());
  expect(panelWidth()).toContain('px');
  expect(JSON.parse(localStorage.getItem('dsb-bill-peek-geom')!).w).toBe(360);
  localStorage.setItem('dsb-bill-peek-geom', '{"x":"bad"}');
  await act(async () => btn('Close bill viewer').click());
  await act(async () => render(null, host));
  await act(async () => render(<BillDocumentPreview blob={blob} />, host));
  await act(async () => btn('View bill document').click());
  expect(JSON.parse(localStorage.getItem('dsb-bill-peek-geom')!).w).toBe(420);
});
