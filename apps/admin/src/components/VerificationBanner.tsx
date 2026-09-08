import { useState } from 'preact/hooks';
import type { Session } from '@dsb-pro/adapters';
import { isEmailVerified, resendVerificationEmail, classifyError, errorMessage } from '@dsb-pro/adapters';

// Soft gate only (spec §7): shown app-wide, dismissible per browser tab,
// never blocks anything except the two actions that check
// isEmailVerified() directly (invite creation, Task 11; export, once export
// ships in a later phase).
export function VerificationBanner({ session }: { session: Session }) {
  const [dismissed, setDismissed] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (dismissed || isEmailVerified(session)) {
    return null;
  }

  async function resend() {
    setError(null);
    try {
      await resendVerificationEmail(session.user.email!);
      setSent(true);
    } catch (err) {
      setError(errorMessage(classifyError(err), err));
    }
  }

  return (
    <div role="status" aria-label="Email verification reminder">
      <p>
        Please verify your email ({session.user.email}).{' '}
        {sent ? 'Verification email sent.' : <button onClick={resend}>Resend email</button>}
      </p>
      {error && <p role="alert">{error}</p>}
      <button aria-label="Dismiss" onClick={() => setDismissed(true)}>
        Dismiss
      </button>
    </div>
  );
}
