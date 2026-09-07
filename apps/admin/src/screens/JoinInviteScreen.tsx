import { useState } from 'preact/hooks';
import { acceptInvite, classifyError, errorMessage } from '@dsb-pro/adapters';
import { useSession } from '../lib/useSession';
import { SignupScreen } from './SignupScreen';

// Deep-link target for a shared invite (spec §5's "dsbpro.in/join/<token>").
// While signed out, shows Signup (default) so a brand-new hire can create an
// account and land right back here; once signed in, auto-submits
// accept_invite(token) exactly once.
//
// BUG FIX #1 (beyond the brief's verbatim code): the brief rendered both
// <SignupScreen /> and <LoginScreen /> here at once. Both forms have their
// own "Email"/"Password" labels and their own "Sign up"/"Log in" buttons, so
// with both mounted simultaneously `getByLabel('Email')` (used by this
// task's own e2e spec, Step 1) matches two elements and Playwright's strict
// mode throws instead of filling either one — provably breaks the verbatim
// spec, not a hypothetical. The comment directly above ("shows Signup
// (default)") already documents single-screen-by-default intent; the fix is
// to render only SignupScreen. An existing team member can still reach Login
// via SignupScreen's own "Already have an account? Log in" link — it routes
// to "/" and loses the token, a known limitation the brief explicitly defers
// ("Team screen (Task 11) will make this a UI click").
//
// BUG FIX #2 (found in review): SignupScreen's own onSubmit unconditionally
// calls route('/') the instant signUp() resolves with an immediate session
// (i.e. whenever email confirmation is disabled — exactly CI's fresh local
// instance config). That fires before this component's own `session` here
// ever moves past 'signed-out', so JoinInviteScreen unmounts and the
// `!attempted && token` branch below never runs — the invite token is
// silently dropped and the new hire lands on NoTenantScreen as if they had
// never had one. Passing onSignedUp (a no-op) suppresses SignupScreen's own
// navigation in this nested context; nothing else needs to happen here
// because this component's own useSession() call re-renders past
// 'signed-out' once the auth-state listener picks up the new session, and
// the existing `!attempted && token` logic below then runs acceptInvite
// exactly as it already did for the "already signed in" case.
export function JoinInviteScreen({ token }: { token?: string }) {
  const session = useSession();
  const [error, setError] = useState<string | null>(null);
  const [attempted, setAttempted] = useState(false);

  if (session.status === 'loading') {
    return <p>Loading…</p>;
  }

  if (session.status === 'signed-out') {
    return (
      <div>
        <p>Sign up or log in to accept this invite.</p>
        <SignupScreen onSignedUp={() => {}} />
      </div>
    );
  }

  if (!attempted && token) {
    setAttempted(true);
    acceptInvite(token)
      .then(() => window.location.reload())
      .catch((err) => setError(errorMessage(classifyError(err), err)));
  }

  if (error) {
    return <p role="alert">{error}</p>;
  }

  return <p>Joining…</p>;
}
