// @vitest-environment jsdom
import { afterEach, expect, test, vi } from 'vitest';
import { render } from 'preact';
import { act } from 'preact/test-utils';
import { lazyScreen } from './lazyScreen';

const host = document.createElement('div');
document.body.append(host);
afterEach(() => {
  act(() => render(null, host));
  vi.unstubAllGlobals();
});
const flush = () => act(async () => void (await Promise.resolve()));
const setOnline = (v: boolean) =>
  Object.defineProperty(navigator, 'onLine', { value: v, configurable: true });
const button = (text: string) =>
  [...host.querySelectorAll('button')].find((b) => b.textContent === text)!;

test('loads the screen and passes props', async () => {
  setOnline(true);
  const Screen = lazyScreen(async () => (p: { n?: number }) => <p>screen {p.n}</p>);
  await act(async () => render(<Screen n={3} />, host));
  await flush();
  expect(host.textContent).toContain('screen 3');
});

test('online and chunk gone: asks to reload the app, never "check the connection"', async () => {
  setOnline(true);
  const Screen = lazyScreen(() => Promise.reject(new Error('404')));
  await act(async () => render(<Screen />, host));
  await flush();
  expect(host.textContent).toContain('needs the latest version');
  expect(host.textContent).not.toContain('Check the connection');
  const reload = vi.fn();
  vi.stubGlobal('location', { ...window.location, reload });
  button('Reload the app').click();
  expect(reload).toHaveBeenCalledOnce();
});

test('offline: first failure offers Try again, a second failure asks to reload', async () => {
  setOnline(false);
  const Screen = lazyScreen(() => Promise.reject(new Error('offline')));
  await act(async () => render(<Screen />, host));
  await flush();
  expect(host.textContent).toContain('Reconnect, then try again');
  await act(async () => button('Try again').click());
  await flush();
  expect(host.textContent).toContain('needs the latest version');
});
