import { render } from 'preact';
import * as Sentry from '@sentry/browser';
import { App } from './App';
import './style.css';

const dsn = import.meta.env.VITE_SENTRY_DSN;
if (dsn) {
  Sentry.init({ dsn });
}

render(<App />, document.getElementById('app')!);
