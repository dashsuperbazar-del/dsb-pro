import { render } from 'preact';
import * as Sentry from '@sentry/browser';
import { App } from './App';
import './tokens.css';
import './style.css';
import './d3.css';
import './d3-screens.css';

const dsn = import.meta.env.VITE_SENTRY_DSN;
if (dsn) Sentry.init({ dsn });

// The offline precache (every chunk, ~270 KiB gz) must never compete with the first screen for the
// phone's bandwidth: register the worker only once the page has loaded AND the browser is idle.
// Offline readiness is unchanged, only a few seconds later; the install itself stays all-or-nothing.
function registerServiceWorker() {
  void navigator.serviceWorker
    .register(
      import.meta.env.BASE_URL +
        'sw.js?v=' +
        encodeURIComponent(import.meta.env.VITE_APP_VERSION ?? 'dev'),
      { scope: import.meta.env.BASE_URL },
    )
    .catch((error) => console.warn('service worker registration failed', error));
}
if ('serviceWorker' in navigator) {
  const whenIdle = () => {
    const ric = (
      window as unknown as {
        requestIdleCallback?: (cb: () => void, opts: { timeout: number }) => void;
      }
    ).requestIdleCallback;
    if (ric) ric(registerServiceWorker, { timeout: 4000 });
    else window.setTimeout(registerServiceWorker, 2000);
  };
  // A hung asset must not delay offline readiness: wait for `load` at most 5 s, then go idle anyway.
  if (document.readyState === 'complete') whenIdle();
  else {
    let done = false;
    const go = () => {
      if (done) return;
      done = true;
      whenIdle();
    };
    window.addEventListener('load', go);
    window.setTimeout(go, 5000);
  }
}

render(<App />, document.getElementById('app')!);
// Drop the static first-paint shell (index.html) now that the real header is on screen.
requestAnimationFrame(() => document.getElementById('boot-shell')?.remove());
