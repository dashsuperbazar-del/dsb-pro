import { useState } from 'preact/hooks';
import { route } from 'preact-router';
import { signUp } from '@dsb-pro/adapters';
import { classifyError, errorMessage } from '@dsb-pro/adapters';
import { passwordStrength } from '@dsb-pro/core';

export function SignupScreen() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: Event) {
    e.preventDefault();
    setError(null);

    const strength = passwordStrength(password);
    if (!strength.valid) {
      setError(strength.message);
      return;
    }

    setBusy(true);
    try {
      await signUp(email, password);
      // SignupScreen is its own top-level route (unlike LoginScreen, which is
      // nested inside Home's signed-out branch and needs no navigation of its
      // own). Route back to "/" so the default route's session-based
      // branching in Home takes over once useSession picks up the new state.
      route('/');
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
