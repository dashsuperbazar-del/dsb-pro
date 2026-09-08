import { useEffect, useState } from 'preact/hooks';
import {
  getSession,
  onAuthStateChange,
  getCurrentMembership,
  registerCurrentDevice,
  classifyError,
  errorMessage,
  type Session,
  type Membership,
} from '@dsb-pro/adapters';

export type SessionState =
  | { status: 'loading' }
  | { status: 'signed-out' }
  | { status: 'error'; message: string }
  | { status: 'no-tenant'; session: Session }
  | { status: 'active'; session: Session; membership: Membership };

// The one place apps/admin decides which of the top-level screens to show.
// Authentication and membership failures are kept distinct from signed-out:
// an authenticated user must never be silently treated as unauthenticated.
export function useSession(): SessionState {
  const [state, setState] = useState<SessionState>({ status: 'loading' });

  useEffect(() => {
    let cancelled = false;
    let registeredForUserId: string | null = null;
    let resolutionId = 0;

    function setError(error: unknown, context: string, id: number) {
      const errorClass = classifyError(error);
      const message = errorMessage(errorClass, error);
      console.error(`useSession: ${context}:`, message);
      if (!cancelled && id === resolutionId) setState({ status: 'error', message });
    }

    async function resolve(session: Session | null) {
      // getSession() and the auth-state listener can race. In particular,
      // signup/sign-in can emit an authenticated session while the initial
      // getSession() is still resolving its earlier signed-out snapshot. A
      // monotonically increasing id makes only the newest auth snapshot
      // authoritative, so a stale signed-out result can never overwrite a
      // newly authenticated state (or vice versa).
      const id = ++resolutionId;

      if (!session) {
        if (!cancelled && id === resolutionId) setState({ status: 'signed-out' });
        return;
      }

      if (registeredForUserId !== session.user.id) {
        registeredForUserId = session.user.id;
        await registerCurrentDevice().catch(() => {
          // Device registration is an owner convenience, not an access gate.
        });
      }

      let membership: Membership | null;
      try {
        membership = await getCurrentMembership();
      } catch (error) {
        setError(error, 'getCurrentMembership failed', id);
        return;
      }

      if (cancelled || id !== resolutionId) return;
      setState(
        membership
          ? { status: 'active', session, membership }
          : { status: 'no-tenant', session },
      );
    }

    void getSession()
      .then(resolve)
      .catch((error) => setError(error, 'getSession failed', ++resolutionId));

    const unsubscribe = onAuthStateChange((session) => {
      void resolve(session);
    });

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  return state;
}
