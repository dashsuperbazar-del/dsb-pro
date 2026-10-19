// @vitest-environment jsdom
/// <reference types="node" />
import { afterEach, expect, test, vi } from 'vitest';
import { render } from 'preact';
import { act } from 'preact/test-utils';
import { DayBookTile } from './DayBookTile';
import { appRoute } from '../lib/paths';
import { readFileSync } from 'node:fs';
const api = vi.hoisted(() => ({
  getDefaultShopId: vi.fn().mockResolvedValue('shop'),
  getShopBusinessDate: vi.fn().mockResolvedValue('2026-10-12'),
  getDayBook: vi.fn(),
}));
vi.mock('@dsb-pro/adapters', () => api);
const host = document.createElement('div');
afterEach(() => {
  act(() => render(null, host));
  vi.clearAllMocks();
});
test('an unresolved day book shows placeholders, then confirmed empty data shows zero', async () => {
  let finish!: (rows: never[]) => void;
  api.getDayBook.mockReturnValue(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  await act(async () => {
    render(<DayBookTile />, host);
  });
  expect(host.textContent).not.toContain('₹0.00');
  expect(host.textContent).toContain('—');
  await act(async () => {
    finish([]);
  });
  await vi.waitFor(() => expect(host.textContent).toContain('₹0.00'));
  expect(host.textContent).toContain('Net money flow');
});
test('failed totals remain an explicit unavailable state, never zero', async () => {
  api.getDayBook.mockRejectedValue(new Error('unavailable'));
  await act(async () => {
    render(<DayBookTile />, host);
  });
  await vi.waitFor(() =>
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('unavailable'),
  );
  expect(host.textContent).not.toContain('₹0.00');
  // The unavailable state keeps its own framed card (the frameless stat-grid layout is for figures only).
  const section = host.querySelector('section[aria-label="Day book today"]');
  expect(section?.classList.contains('daybook-error')).toBe(true);
  expect(section?.querySelector('.tiles')).toBeNull();
});
// Selector-level check against the real style.css: no rule that strips the card frame
// (padding/border/background) may match the unavailable state on Home; the figures layout must match one.
test('on Home the unavailable state keeps its card frame; the figures layout drops it', async () => {
  const style = document.createElement('style');
  // Vitest stubs CSS imports (even ?raw), so the real stylesheet is read from disk.
  style.textContent = readFileSync(`${__dirname}/../style.css`, 'utf8');
  document.head.append(style);
  const main = document.createElement('main');
  main.className = 'dashboard';
  document.body.append(main);
  const strippers = [...style.sheet!.cssRules]
    .filter((r): r is CSSStyleRule => r instanceof CSSStyleRule)
    .filter((r) => /daybook-tile/.test(r.selectorText))
    .filter((r) =>
      ['0', '0px', 'none'].some((v) =>
        [r.style.padding, r.style.border, r.style.background].includes(v),
      ),
    );
  const stripped = (el: Element) => strippers.some((r) => el.matches(r.selectorText));
  try {
    api.getDayBook.mockRejectedValue(new Error('unavailable'));
    await act(async () => {
      render(<DayBookTile />, main);
    });
    await vi.waitFor(() => expect(main.querySelector('[role="alert"]')).not.toBeNull());
    expect(stripped(main.querySelector('section')!)).toBe(false);
    act(() => render(null, main));
    api.getDayBook.mockResolvedValue([]);
    await act(async () => {
      render(<DayBookTile />, main);
    });
    await vi.waitFor(() => expect(main.textContent).toContain('₹0.00'));
    expect(stripped(main.querySelector('section')!)).toBe(true);
  } finally {
    act(() => render(null, main));
    main.remove();
    style.remove();
  }
});
test('figures render as separate stat cards with fixed tones; the link keeps its target', async () => {
  api.getDayBook.mockResolvedValue([
    {
      business_date: '2026-10-12',
      sales_paise: 12345,
      receipts_paise: 2000,
      payments_paise: 500,
      expenses_paise: 100,
      net_cashflow_paise: 1400,
    },
  ]);
  await act(async () => {
    render(<DayBookTile />, host);
  });
  await vi.waitFor(() => expect(host.textContent).toContain('₹123.45'));
  const cards = [...host.querySelectorAll('.tiles > .stat')];
  expect(cards.map((c) => c.querySelector('dt')?.textContent)).toEqual([
    'Net sales',
    'Received',
    'Paid out',
    'Expenses',
    'Net money flow',
  ]);
  const tone = (label: string) =>
    cards.find((c) => c.querySelector('dt')?.textContent === label)!.className;
  expect(tone('Net sales')).toContain('tone-accent');
  expect(tone('Received')).toContain('tone-success');
  expect(tone('Net money flow')).toContain('daybook-net');
  // Tone is fixed per figure, never derived from the amount.
  expect(tone('Paid out')).not.toMatch(/tone-/);
  const link = host.querySelector<HTMLAnchorElement>('a.daybook-link');
  expect(link?.textContent).toContain('Full day book');
  expect(link?.getAttribute('href')).toBe(appRoute.reports);
});
