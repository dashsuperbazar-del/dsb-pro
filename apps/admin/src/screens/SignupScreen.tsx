import { useState } from 'preact/hooks';
import { route } from 'preact-router';
import { signUp } from '@dsb-pro/adapters';
import { classifyError, errorMessage } from '@dsb-pro/adapters';
import { passwordStrength } from '@dsb-pro/core';
import { appRoute } from '../lib/paths';

export function SignupScreen({ onSignedUp, onLogIn }: { onSignedUp?: () => void; onLogIn?: () => void } = {}) {
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
        if (onSignedUp) onSignedUp();
        else route(appRoute.home);
      } else {
        setConfirmationPending(true);
      }
    } catch (err) {
      setError(errorMessage(classifyError(err), err));
    } finally {
      setBusy(false);
    }
  }

  function logIn(e: Event) {
    if (onLogIn) {
      e.preventDefault();
      onLogIn();
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
          <input type="password" value={password} onInput={(e) => setPassword((e.target as HTMLInputElement).value)} required />
        </label>
        {error && <p role="alert">{error}</p>}
        {confirmationPending && <p role="status">Check your email to confirm your account before logging in.</p>}
        <button type="submit" disabled={busy}>Sign up</button>
      </form>
      <p>
        Already have an account? <a href={appRoute.home} onClick={logIn}>Log in</a>
      </p>
    </main>
  );
}
