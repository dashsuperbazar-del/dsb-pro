// @vitest-environment jsdom
import { afterEach, expect, test, vi } from 'vitest';
import { render } from 'preact';
import { act } from 'preact/test-utils';
import { HealthPanel } from './HealthPanel';

const api = vi.hoisted(() => ({
  checkInvariants: vi.fn(),
  getLatestBackupHealth: vi.fn(),
  getDefaultShopId: vi.fn().mockResolvedValue('shop'),
  getShopSettings: vi.fn().mockResolvedValue({ allowNegativeStock: false }),
  listItems: vi.fn(),
  listBelowZeroStock: vi.fn(),
}));
vi.mock('@dsb-pro/adapters', () => api);
const host = document.createElement('div');
document.body.append(host);
afterEach(() => {
  act(() => render(null, host));
  vi.clearAllMocks();
  vi.useRealTimers();
});
// Let the mocked reads answer and the panel draw their result.
const settle = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
const healthyBackup = {
  status: 'success',
  finished_at: new Date().toISOString(),
  destinations: [
    { name: 'B2', verified: true },
    { name: 'R2', verified: true },
  ],
};
async function toggle(panel: HTMLDetailsElement, open: boolean) {
  await act(async () => {
    panel.open = open;
    panel.dispatchEvent(new Event('toggle'));
  });
}

test('manual expansion survives health changing from attention to clear', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-12T08:30:00Z'));
  let finish!: (value: unknown) => void;
  api.checkInvariants.mockReturnValue(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  api.getLatestBackupHealth.mockResolvedValue({
    ...healthyBackup,
    finished_at: new Date(Date.now() + 1000).toISOString(),
  });
  await act(async () => {
    render(<HealthPanel />, host);
  });
  const panel = host.querySelector<HTMLDetailsElement>('.health-summary')!;
  await toggle(panel, true);
  vi.setSystemTime(new Date(Date.now() + 2000));
  await act(async () => {
    finish({ ok: true, saleTotalViolations: 0 });
  });
  expect(panel.open).toBe(true);
  expect(panel.textContent).toContain('All clear');
  await toggle(panel, false);
  await act(async () => {
    render(<HealthPanel canAdjustStock />, host);
  });
  expect(panel.open).toBe(false);
});

test('a late invariant failure opens the warning without user interaction', async () => {
  let finish!: (value: unknown) => void;
  api.checkInvariants.mockReturnValue(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  api.getLatestBackupHealth.mockResolvedValue(healthyBackup);
  await act(async () => {
    render(<HealthPanel />, host);
  });
  const panel = host.querySelector<HTMLDetailsElement>('.health-summary')!;
  expect(panel.open).toBe(false);
  await act(async () => {
    finish({ ok: false, saleTotalViolations: 1 });
  });
  expect(panel.open).toBe(true);
  expect(panel.textContent).toContain('Stop financial posting');
});

test('on a counter screen the panel is hidden unless a financial check FAILED', async () => {
  api.getLatestBackupHealth.mockResolvedValue(null);
  api.checkInvariants.mockResolvedValue({ ok: true, saleTotalViolations: 0 });
  await act(async () => {
    render(<HealthPanel quiet />, host);
  });
  await settle();
  // A missing backup would say "Needs attention" on Home; here nothing is shown.
  expect(host.textContent).toBe('');
  api.checkInvariants.mockResolvedValue({ ok: false, saleTotalViolations: 2 });
  await act(async () => {
    render(null, host);
    render(<HealthPanel quiet />, host);
  });
  await settle();
  const banner = host.querySelector('[data-testid="health-banner"]')!;
  expect(banner.getAttribute('role')).toBe('alert');
  expect(banner.textContent).toContain('Stop financial posting');
});

test('a check that could not run is not a FAIL banner on a counter screen', async () => {
  api.getLatestBackupHealth.mockResolvedValue(healthyBackup);
  api.checkInvariants.mockRejectedValue(new Error('offline'));
  await act(async () => {
    render(<HealthPanel quiet />, host);
  });
  await settle();
  expect(host.textContent).toBe('');
});
