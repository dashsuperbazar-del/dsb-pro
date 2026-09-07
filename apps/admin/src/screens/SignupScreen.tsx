import { useState } from 'preact/hooks';
import { route } from 'preact-router';
import { signUp } from '@dsb-pro/adapters';
import { classifyError, errorMessage } from '@dsb-pro/adapters';
import { passwordStrength } from '@dsb-pro/core';

export function SignupScreen() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [confirmationPending, setConfirmationPending] = useState(false);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: Event) {
    e.preventDefault();
    setError(null);
    setConfirmationPending(false);

    const strength = passwordStrength(password);
    if (!strength.valid) {
      setError(strength.message);
      return;
    }

    setBusy(true);
    try {
      const session = await signUp(email, password);
      if (session) {
        // SignupScreen is its own top-level route (unlike LoginScreen, which
        // is nested inside Home's signed-out branch and needs no navigation
        // of its own). Route back to "/" so the default route's
        // session-based branching in Home takes over now that useSession
        // has a session to pick up.
        route('/');
      } else {
        // Supabase resolves signUp() without throwing even when the
        // project's Auth settings require email confirmation — no session
        // is created yet, so useSession still reports signed-out. Without
        // this, the user would land back on this same form with zero
        // indication their signup actually worked.
        setConfirmationPending(true);
      }
    } catch (err) {
      setError(errorMessage(classifyError(err), err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main>
      <h1>Sign up</h1>
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
        {confirmationPending && (
          <p role="status">Check your email to confirm your account before logging in.</p>
        )}
        <button type="submit" disabled={busy}>
          Sign up
        </button>
      </form>
      <p>
        Already have an account? <a href="/">Log in</a>
      </p>
    </main>
  );
}
