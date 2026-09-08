import { useEffect, useState } from 'preact/hooks';
import { acceptInvite, classifyError, errorMessage } from '@dsb-pro/adapters';
import { useSession } from '../lib/useSession';
import { appRoute } from '../lib/paths';
import { LoginScreen } from './LoginScreen';
import { SignupScreen } from './SignupScreen';

// Deep-link target for a shared invite. While signed out, either signup or
// login stays on this route so the invite token is never silently discarded.
export function JoinInviteScreen({ token }: { token?: string }) {
  const session = useSession();
  const [error, setError] = useState<string | null>(null);
  const [attempted, setAttempted] = useState(false);
  const [mode, setMode] = useState<'signup' | 'login'>('signup');

  async function acceptCurrentInvite() {
    if (attempted || !token) return;
    setAttempted(true);
    try {
      await acceptInvite(token);
      window.location.reload();
    } catch (err) {
      setError(errorMessage(classifyError(err), err));
    }
  }

  useEffect(() => {
    if (session.status === 'no-tenant') void acceptCurrentInvite();
    if (session.status === 'active') window.location.href = appRoute.home;
  }, [session.status]);

  if (session.status === 'loading') return <p>Loading…</p>;
  if (session.status === 'error') return <p role="alert">{session.message}</p>;

  if (session.status === 'signed-out') {
    return mode === 'signup' ? (
      <div>
        <p>Sign up or log in to accept this invite.</p>
        <SignupScreen onSignedUp={() => void acceptCurrentInvite()} onLogIn={() => setMode('login')} />
      </div>
    ) : (
      <div>
        <p>Log in to accept this invite.</p>
        <LoginScreen onSignedIn={() => void acceptCurrentInvite()} />
        <p><button type="button" onClick={() => setMode('signup')}>Create a new account</button></p>
      </div>
    );
  }

  if (error) return <p role="alert">{error}</p>;
  return <p>Joining…</p>;
}
