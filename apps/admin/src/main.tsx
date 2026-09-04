import { render } from 'preact';
import './style.css';

function App() {
  return (
    <main>
      <h1>DSB Pro — Admin</h1>
      <p>Phase 0 placeholder. Billing, inventory, and everything else arrives in later phases.</p>
    </main>
  );
}

render(<App />, document.getElementById('app')!);
