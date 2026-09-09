import { render } from 'preact';
import * as Sentry from '@sentry/browser';
import { App } from './App';
import './style.css';

const dsn = import.meta.env.VITE_SENTRY_DSN;
if (dsn) Sentry.init({ dsn });

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    void navigator.serviceWorker.register(import.meta.env.BASE_URL + 'sw.js?v=' + encodeURIComponent(import.meta.env.VITE_APP_VERSION ?? 'dev'), { scope: import.meta.env.BASE_URL })
      .catch(error => console.warn('service worker registration failed', error));
  });
}

render(<App />, document.getElementById('app')!);
