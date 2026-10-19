// @vitest-environment jsdom
import { afterEach, expect, test, vi } from 'vitest';
import { DISCARD_PROMPT, confirmDiscard, setDirty } from './dirtyGuard';

const a = Symbol('a');
const b = Symbol('b');
afterEach(() => {
  setDirty(a, false);
  setDirty(b, false);
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});
function unload() {
  const e = new Event('beforeunload', { cancelable: true });
  window.dispatchEvent(e);
  return e.defaultPrevented;
}
function clickLink(href: string) {
  const link = document.createElement('a');
  link.href = href;
  document.body.append(link);
  const e = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 });
  let routed = false;
  // Stands in for the router: a blocked click never reaches it; it stops jsdom navigating.
  const router = (ev: Event) => {
    routed = !ev.defaultPrevented;
    ev.preventDefault();
  };
  document.addEventListener('click', router);
  link.dispatchEvent(e);
  document.removeEventListener('click', router);
  return !routed;
}

test('beforeunload prompts only while some entry is dirty', () => {
  expect(unload()).toBe(false);
  setDirty(a, true);
  setDirty(b, true);
  expect(unload()).toBe(true);
  setDirty(a, false);
  expect(unload()).toBe(true);
  setDirty(b, false);
  expect(unload()).toBe(false);
});

test('an in-app link asks before leaving a dirty entry and stays when declined', () => {
  const ask = vi.spyOn(window, 'confirm').mockReturnValue(false);
  expect(clickLink('/reports')).toBe(false);
  expect(ask).not.toHaveBeenCalled();
  setDirty(a, true);
  expect(clickLink('/reports')).toBe(true);
  expect(ask).toHaveBeenCalledWith(DISCARD_PROMPT);
  ask.mockReturnValue(true);
  expect(clickLink('/reports')).toBe(false);
});

test('confirmDiscard asks only when dirty', () => {
  const ask = vi.spyOn(window, 'confirm').mockReturnValue(false);
  expect(confirmDiscard()).toBe(true);
  expect(ask).not.toHaveBeenCalled();
  setDirty(a, true);
  expect(confirmDiscard()).toBe(false);
  expect(DISCARD_PROMPT).toBe('Discard unsaved entry?');
});
