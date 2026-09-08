import { useEffect, useState } from 'preact/hooks';
import { acceptInvite, classifyError, errorMessage } from '@dsb-pro/adapters';
import { useSession } from '../lib/useSession';
import { SignupScreen } from './SignupScreen';

// Deep-link target for a shared invite (spec §5's "dsbpro.in/join/<token>").
// While signed out, shows Signup so a brand-new hire can create an account and
// land right back here; once signed in, accepts the token exactly once.
export function JoinInviteScreen({ token }: { token?: string }) {
  const session = useSession();
  const [error, setError] = useState<string | null>(null);
  const [attempted, setAttempted] = useState(false);

  useEffect(() => {
    if (session.status === 'active') {
      window.location.href = '/';
    }
  }, [session.status]);

  useEffect(() => {
    if (session.status !== 'no-tenant' || attempted || !token) return;

    let cancelled = false;
    setAttempted(true);
    void acceptInvite(token)
      .then(() => {
        if (!cancelled) window.location.reload();
      })
      .catch((err) => {
        if (!cancelled) setError(errorMessage(classifyError(err), err));
      });

    return () => {
      cancelled = true;
    };
  }, [session.status, attempted, token]);

  if (session.status === 'loading') {
    return <p>Loading…</p>;
  }

  if (session.status === 'error') {
    return (
      <p role="alert">
        {session.message}
      </p>
    );
  }

  if (session.status === 'signed-out') {
    return (
      <div>
        <p>Sign up or log in to accept this invite.</p>
        <SignupScreen onSignedUp={() => {}} />
      </div>
    );
  }

  if (error) {
    return <p role="alert">{error}</p>;
  }

  return <p>Joining…</p>;
}
