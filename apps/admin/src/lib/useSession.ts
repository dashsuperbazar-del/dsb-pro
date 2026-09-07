import { useEffect, useState } from 'preact/hooks';
import {
  getSession,
  onAuthStateChange,
  getCurrentMembership,
  registerCurrentDevice,
  type Session,
  type Membership,
} from '@dsb-pro/adapters';

export type SessionState =
  | { status: 'loading' }
  | { status: 'signed-out' }
  | { status: 'no-tenant'; session: Session }
  | { status: 'active'; session: Session; membership: Membership };

// The one place apps/admin decides which of the four top-level screens to
// show (spec §2's routing table). Registers this device once per new
// session (not on every render) — register_device() is idempotent
// (on conflict do update) so a duplicate call is harmless, but there's no
// reason to call it more than once per sign-in.
export function useSession(): SessionState {
  const [state, setState] = useState<SessionState>({ status: 'loading' });

  useEffect(() => {
    let cancelled = false;
    let registeredForUserId: string | null = null;

    async function resolve(session: Session | null) {
      if (!session) {
        if (!cancelled) setState({ status: 'signed-out' });
        return;
      }
      if (registeredForUserId !== session.user.id) {
        registeredForUserId = session.user.id;
        await registerCurrentDevice().catch(() => {
          // Device registration failing must never block sign-in — it's a
          // convenience list for the owner, not an access gate.
        });
      }
      const membership = await getCurrentMembership();
      if (cancelled) return;
      setState(
        membership
          ? { status: 'active', session, membership }
          : { status: 'no-tenant', session },
      );
    }

    getSession().then(resolve);
    const unsubscribe = onAuthStateChange((session) => {
      resolve(session);
    });

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  return state;
}
