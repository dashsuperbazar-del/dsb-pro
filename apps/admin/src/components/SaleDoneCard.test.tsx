// @vitest-environment jsdom
import { render } from 'preact';
import { act } from 'preact/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SaleDoneCard, type SaleDoneInfo } from './SaleDoneCard';

let host: HTMLElement;
afterEach(() => {
  if (host) {
    render(null, host);
    host.remove();
  }
});
const base: SaleDoneInfo = {
  kind: 'synced',
  clientId: 'c1',
  docNo: 'INV-000005',
  billCode: 'K7M2-QX9P',
  figures: { totalPaise: 264700, paidPaise: 200000, balancePaise: 64700 },
  customerName: 'Ravi Kumar',
  note: '',
};
function mount(info: SaleDoneInfo, extra: Record<string, unknown> = {}) {
  host = document.createElement('div');
  document.body.append(host);
  const handlers = { onNewSale: vi.fn(), onClose: vi.fn(), onPrint: vi.fn() };
  act(() => render(<SaleDoneCard info={info} {...handlers} {...extra} />, host));
  return handlers;
}
const buttons = () =>
  [...host.querySelectorAll('.sale-done-actions button')].map((b) => b.textContent);

describe('SaleDoneCard', () => {
  it('shows the total, paid, balance on credit, invoice and bill code of a synced sale', () => {
    mount(base);
    const text = host.textContent ?? '';
    expect(host.querySelector('[role="status"]')?.textContent).toBe('Sale finalized: INV-000005.');
    expect(host.querySelector('.sale-done-total strong')?.textContent).toBe('₹2,647.00');
    expect(text).toContain('Paid₹2,000.00');
    expect(text).toContain('Balance on credit₹647.00');
    expect(text).toContain('CustomerRavi Kumar');
    expect(text).toContain('InvoiceINV-000005');
    expect(host.querySelector('[data-testid="bill-code"]')?.textContent).toContain('K7M2-QX9P');
  });
  it('says fully paid when nothing is left on credit', () => {
    mount({ ...base, figures: { totalPaise: 10000, paidPaise: 10000, balancePaise: 0 } });
    expect(host.textContent).toContain('BalanceNil, fully paid');
    expect(host.textContent).not.toContain('Balance on credit');
  });
  it('a queued sale says it is saved on this device and will sync, with no bill code yet', () => {
    mount({
      ...base,
      kind: 'queued',
      docNo: 'T-aff303fa-ae95-492c-aaaa-bbbbbbbbbbbb',
      billCode: null,
    });
    const status = host.querySelector('[role="status"]')!.textContent!;
    expect(status).toContain('Saved on this device — will sync');
    expect(status).toContain('Saved locally as T-aff303fa-ae95-492c-aaaa-bbbbbbbbbbbb');
    expect(host.textContent).toContain('Provisional numberT-aff303fa…');
    expect(host.querySelector('[data-testid="bill-code"]')).toBeNull();
  });
  it('New sale, Print and Close call their handlers; Print is left out when it cannot run', () => {
    const h = mount(base);
    expect(buttons()).toEqual(['New sale', 'Print receipt', 'Close']);
    const click = (name: string) =>
      act(() => [...host.querySelectorAll('button')].find((b) => b.textContent === name)!.click());
    click('New sale');
    click('Print receipt');
    click('Close');
    expect(h.onNewSale).toHaveBeenCalledOnce();
    expect(h.onPrint).toHaveBeenCalledOnce();
    expect(h.onClose).toHaveBeenCalledOnce();
    render(null, host);
    mount(base, { onPrint: undefined });
    expect(buttons()).toEqual(['New sale', 'Close']);
  });
  it('shows no amounts at all when the figures are unknown (never a made-up zero)', () => {
    mount({ ...base, figures: null });
    expect(host.querySelector('.sale-done-total')).toBeNull();
    expect(host.textContent).not.toContain('Paid');
  });
});
