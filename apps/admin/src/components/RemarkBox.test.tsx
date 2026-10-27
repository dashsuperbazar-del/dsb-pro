// @vitest-environment jsdom
import { render } from 'preact';
import { afterEach, expect, it, vi } from 'vitest';

vi.mock('@dsb-pro/adapters', async (orig) => ({
  ...((await orig()) as object),
  listDocumentRemarks: vi.fn(async () => []),
  savedRemarkClientIds: vi.fn(async () => []),
}));
import { RemarkBox } from './RemarkBox';

let host: HTMLElement;
afterEach(() => {
  render(null, host);
  host.remove();
  localStorage.clear();
});

// Regression: the box's reset effect runs after paint. A remark typed before it ran used to be wiped,
// leaving "Add remark" disabled with nothing to send (seen as a rare e2e timeout).
it('keeps text typed before the first effect run', async () => {
  host = document.createElement('div');
  document.body.append(host);
  render(<RemarkBox shopId="s1" docKind="sale" docId="d1" userId="u1" role="owner" />, host);
  const box = host.querySelector<HTMLTextAreaElement>('textarea[aria-label="New remark"]')!;
  box.value = 'Customer collects tomorrow';
  box.dispatchEvent(new Event('input', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 50));
  const add = [...host.querySelectorAll('button')].find((b) => b.textContent === 'Add remark')!;
  expect(host.querySelector<HTMLTextAreaElement>('textarea')!.value).toBe(
    'Customer collects tomorrow',
  );
  expect(add.disabled).toBe(false);
});
