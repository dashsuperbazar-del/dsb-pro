import { render } from 'preact';
import * as Sentry from '@sentry/browser';
import { HealthPanel } from './HealthPanel';
import './style.css';

const dsn = import.meta.env.VITE_SENTRY_DSN;
if (dsn) {
  Sentry.init({ dsn });
}

function App() {
  return (
    <main>
      <h1>DSB Pro — Admin</h1>
      <p>Phase 0 placeholder. Billing, inventory, and everything else arrives in later phases.</p>
      <button onClick={() => Sentry.captureMessage('Phase 0 Sentry wiring test')}>
        Send test event to Sentry
      </button>
      <HealthPanel />
    </main>
  );
}

render(<App />, document.getElementById('app')!);
