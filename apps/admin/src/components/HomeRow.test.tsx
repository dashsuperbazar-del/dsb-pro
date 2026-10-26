// @vitest-environment jsdom
import { render } from 'preact';
import { act } from 'preact/test-utils';
import { afterEach, describe, expect, it } from 'vitest';
import { HomeRow } from './HomeRow';
import { syncLabel } from './SyncIndicator';

let host: HTMLElement;
afterEach(() => {
  if (host) {
    render(null, host);
    host.remove();
  }
  localStorage.clear();
});
function mount() {
  host = document.createElement('div');
  document.body.append(host);
  act(() =>
    render(
      <HomeRow
        name="t"
        title="Needs attention"
        userId="u1"
        count={2}
        tone="danger"
        summary="₹5 owed"
      >
        <a href="/x">Review</a>
      </HomeRow>,
      host,
    ),
  );
  return host.querySelector('button')!;
}
describe('HomeRow', () => {
  it('starts collapsed, expands on tap and remembers the choice per user', () => {
    const button = mount();
    expect(button.getAttribute('aria-expanded')).toBe('false');
    const body = host.querySelector(`#${button.getAttribute('aria-controls')}`) as HTMLElement;
    expect(body.hidden).toBe(true);
    expect(button.textContent).toContain('Needs attention');
    expect(button.querySelector('.badge.danger')?.textContent).toBe('2');
    act(() => button.click());
    expect(button.getAttribute('aria-expanded')).toBe('true');
    expect(body.hidden).toBe(false);
    expect(localStorage.getItem('dsb-pro:home-open:u1:t')).toBe('1');
    render(null, host);
    host.remove();
    expect(mount().getAttribute('aria-expanded')).toBe('true');
  });
});
describe('syncLabel', () => {
  const base = { online: true, running: false, pending: 0, conflicts: 0 };
  it('names each state from existing local counts', () => {
    expect(syncLabel(base).text).toBe('Online');
    expect(syncLabel({ ...base, online: false }).text).toBe('Offline');
    expect(syncLabel({ ...base, pending: 3 }).text).toBe('Syncing 3');
    expect(syncLabel({ ...base, online: false, pending: 2 }).text).toBe('Offline · 2');
    expect(syncLabel({ ...base, conflicts: 2, pending: 1 }).text).toBe('2 need attention');
    expect(syncLabel({ ...base, conflicts: 1 }).tone).toBe('attention');
  });
});
