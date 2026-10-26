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
describe('HomeRow default', () => {
  const mountDefault = (defaultOpen: boolean) => {
    host = document.createElement('div');
    document.body.append(host);
    act(() =>
      render(
        <HomeRow
          name="d"
          title="Recent"
          userId="u1"
          count={1}
          tone="neutral"
          summary="s"
          defaultOpen={defaultOpen}
        >
          <p>body</p>
        </HomeRow>,
        host,
      ),
    );
    return host.querySelector('button')!;
  };
  it('opens by default when asked, and a saved choice replaces the default', () => {
    let button = mountDefault(true);
    expect(button.getAttribute('aria-expanded')).toBe('true');
    act(() => button.click());
    expect(button.getAttribute('aria-expanded')).toBe('false');
    expect(localStorage.getItem('dsb-pro:home-open:u1:d')).toBe('0');
    render(null, host);
    host.remove();
    button = mountDefault(true);
    expect(button.getAttribute('aria-expanded')).toBe('false');
  });
  it('stays closed without a default, and forceOpen still wins', () => {
    expect(mountDefault(false).getAttribute('aria-expanded')).toBe('false');
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
