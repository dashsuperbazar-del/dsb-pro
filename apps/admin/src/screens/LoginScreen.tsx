import { useState } from 'preact/hooks';
import { signIn, resetPasswordForEmail } from '@dsb-pro/adapters';
import { classifyError, errorMessage } from '@dsb-pro/adapters';
import { appRoute } from '../lib/paths';

export function LoginScreen({ onSignedIn }: { onSignedIn?: () => void } = {}) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: Event) {
    e.preventDefault();
    setError(null);
    setStatus(null);
    setBusy(true);
    try {
      await signIn(email, password);
      if (onSignedIn) onSignedIn();
      // Otherwise useSession's auth listener picks up the new session.
    } catch (err) {
      setError(errorMessage(classifyError(err), err));
    } finally {
      setBusy(false);
    }
  }

  async function onResetPassword() {
    setError(null);
    setStatus(null);
    if (!email.trim()) {
      setError('Enter your email address first.');
      return;
    }
    setBusy(true);
    try {
      await resetPasswordForEmail(email.trim());
      setStatus('If that account exists, a password reset email has been sent.');
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
        {status && <p role="status">{status}</p>}
        <button type="submit" disabled={busy}>
          Log in
        </button>{' '}
        <button type="button" disabled={busy} onClick={() => void onResetPassword()}>
          Forgot password?
        </button>
      </form>
      <p>
        No account? <a href={appRoute.signup}>Sign up</a>
      </p>
    </main>
  );
}
