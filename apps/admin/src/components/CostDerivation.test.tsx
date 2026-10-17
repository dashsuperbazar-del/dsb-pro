// @vitest-environment jsdom
import { afterEach, expect, test, vi } from 'vitest';
import { render } from 'preact';
import { act } from 'preact/test-utils';
import { CostDerivation } from './CostDerivation';
import { deriveUnitCostFromTotal } from '../lib/purchaseCost';

const host = document.createElement('div');
document.body.append(host);
afterEach(async () => act(async () => render(null, host)));

test('an exact total shows the unit cost and no warning', async () => {
  await act(async () =>
    render(<CostDerivation derived={deriveUnitCostFromTotal('4', '100')} onUse={() => {}} />, host),
  );
  expect(host.textContent).toContain('₹25.00 per unit');
  expect(host.querySelector('.alert')).toBeNull();
});

test('an inexact total states the difference and offers the stored cost only on click', async () => {
  const onUse = vi.fn();
  await act(async () =>
    render(<CostDerivation derived={deriveUnitCostFromTotal('3', '100')} onUse={onUse} />, host),
  );
  expect(host.textContent).toContain('cannot be stored exactly');
  expect(host.textContent).toContain('₹0.01 less');
  expect(onUse).not.toHaveBeenCalled();
  await act(async () => host.querySelector('button')!.click());
  expect(onUse).toHaveBeenCalledWith(3333);
});

test('bad input shows the plain message', async () => {
  await act(async () =>
    render(<CostDerivation derived={deriveUnitCostFromTotal('0', '10')} onUse={() => {}} />, host),
  );
  expect(host.textContent).toContain('greater than zero');
});
