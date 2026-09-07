import { useState } from 'preact/hooks';
import { signIn } from '@dsb-pro/adapters';
import { classifyError, errorMessage } from '@dsb-pro/adapters';

export function LoginScreen() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: Event) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await signIn(email, password);
      // useSession's onAuthStateChange listener picks up the new session and
      // re-renders Home — no manual navigation needed here.
    } catch (err) {
      setError(errorMessage(classifyError(err), err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main>
      <h1>Log in</h1>
      <form onSubmit={onSubmit}>
        <label>
          Email
          <input type="email" value={email} onInput={(e) => setEmail((e.target as HTMLInputElement).value)} required />
        </label>
        <label>
          Password
          <input
            type="password"
            value={password}
            onInput={(e) => setPassword((e.target as HTMLInputElement).value)}
            required
          />
        </label>
        {error && <p role="alert">{error}</p>}
        <button type="submit" disabled={busy}>
          Log in
        </button>
      </form>
      <p>
        No account? <a href="/signup">Sign up</a>
      </p>
    </main>
  );
}
