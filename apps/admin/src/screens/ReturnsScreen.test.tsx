// @vitest-environment jsdom
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { render } from 'preact';
import { act } from 'preact/test-utils';
import { ReturnsScreen } from './ReturnsScreen';

const api = vi.hoisted(() => ({
  getShopBusinessDate: vi.fn(),
  listRecentReturns: vi.fn(),
}));
vi.mock('@dsb-pro/adapters', () => api);
const offline = vi.hoisted(() => ({
  getOfflineRuntimeIdentity: vi.fn(() => ({ shopId: 'shop' })),
  getOfflineBusinessDate: vi.fn(async () => '2026-10-20'),
  getOfflineReturnSources: vi.fn(async () => []),
  getOfflineReturnLines: vi.fn(async () => []),
  listOfflineReturns: vi.fn(async () => []),
  postReturnResilient: vi.fn(),
  refreshOfflineReturnSources: vi.fn(async () => undefined),
  recordLocalReturnVoid: vi.fn(async () => undefined),
  voidReturnResilient: vi.fn(),
  hasPendingReturnVoid: vi.fn(async () => false),
  waitForOfflineRuntime: vi.fn(async () => undefined),
}));
vi.mock('../lib/offlineSync', () => offline);

const host = document.createElement('div');
const row = (id: string, total: number, roundOff: number) => ({
  id,
  doc_no: id,
  business_date: '2026-10-20',
  status: 'POSTED',
  total_paise: total,
  round_off_paise: roundOff,
  created_at: '2026-10-20T10:00:00Z',
  return_type: 'PURCHASE',
});
beforeEach(() => {
  document.body.append(host);
  vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true);
});
afterEach(() => {
  act(() => render(null, host));
  host.remove();
  vi.restoreAllMocks();
});

test('a purchase return that completes a rounded bill shows its round off, so the total adds up', async () => {
  // Items ₹100.49, bill rounded down by ₹0.49 → the completing return takes back ₹100.00.
  api.listRecentReturns.mockResolvedValue([row('PR-1', 10000, -49), row('PR-2', 5025, 0)]);
  await act(async () => render(<ReturnsScreen />, host));
  await vi.waitFor(() => expect(host.textContent).toContain('PR-2'));
  const cells = (doc: string) =>
    [...host.querySelectorAll('tr')].find((tr) => tr.textContent!.startsWith(doc))!.textContent!;
  expect(cells('PR-1')).toContain('₹100.00');
  expect(cells('PR-1')).toContain('Round off −₹0.49');
  expect(cells('PR-2')).not.toContain('Round off');
});
