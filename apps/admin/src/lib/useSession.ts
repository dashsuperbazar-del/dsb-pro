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
import { cacheOfflineMembership, getCachedOfflineMembership } from '@dsb-pro/sync';

export type SessionState =
  | { status: 'loading' }
  | { status: 'signed-out' }
  | { status: 'error'; message: string }
  | { status: 'no-tenant'; session: Session }
  | { status: 'active'; session: Session; membership: Membership; offline: boolean };

class DeviceRevoked extends Error {}

export function useSession(): SessionState {
  const [state, setState] = useState<SessionState>({ status: 'loading' });

  useEffect(() => {
    let cancelled = false;
    let registeredForUserId: string | null = null;
    let resolutionId = 0;

    // Keep the SAME state object when a revalidation returns what is already on screen, so the Home
    // tiles do not remount and re-fetch (the cached membership is shown first, the server's confirms it).
    function setActive(next: Extract<SessionState, { status: 'active' }>) {
      setState((prev) =>
        prev.status === 'active' &&
        prev.offline === next.offline &&
        prev.session.user.id === next.session.user.id &&
        prev.membership.tenantId === next.membership.tenantId &&
        prev.membership.role === next.membership.role &&
        prev.membership.shopIds.join(',') === next.membership.shopIds.join(',')
          ? prev
          : next,
      );
    }

    // The two start-up resolutions (getSession + the first auth event) share one membership read.
    let membershipInFlight: ReturnType<typeof getCurrentMembership> | null = null;
    function readMembership() {
      const p = (membershipInFlight ??= getCurrentMembership());
      void p.then(
        () => (membershipInFlight = null),
        () => (membershipInFlight = null),
      );
      return p;
    }

    function setError(error: unknown, context: string, id: number) {
      const errorClass = classifyError(error);
      const message = errorMessage(errorClass, error);
      console.error(`useSession: ${context}:`, message);
      if (!cancelled && id === resolutionId) setState({ status: 'error', message });
    }

    async function resolve(session: Session | null) {
      const id = ++resolutionId;
      if (!session) {
        if (!cancelled && id === resolutionId) setState({ status: 'signed-out' });
        return;
      }

      // Boot-order (perf): the device registration and the membership read are independent, so they run
      // together instead of one after the other, and a membership this device already verified opens the
      // app at once (stale-while-revalidate): the server answer replaces it moments later, and a revoked
      // device still stops with the same error. Every write/read is still authorised by the server (RLS).
      let registration: Promise<void> = Promise.resolve();
      if (registeredForUserId !== session.user.id) {
        registeredForUserId = session.user.id;
        registration = registerCurrentDevice().then(
          () => undefined,
          (error: unknown) => {
            const message = error instanceof Error ? error.message : String(error);
            if (/device revoked/i.test(message)) throw new DeviceRevoked();
            // Network failure must not destroy offline access. Membership below
            // will fall back to the last verified cache if the backend is down.
          },
        );
      }
      const cachedNow = getCachedOfflineMembership(session.user.id);
      if (cachedNow && !cancelled && id === resolutionId) {
        setActive({
          status: 'active',
          session,
          membership: {
            tenantId: cachedNow.tenantId,
            role: cachedNow.role,
            shopIds: cachedNow.shopIds,
          },
          offline: false,
        });
      }
      const membershipRead = readMembership().then(
        (value) => ({ value }) as const,
        (error: unknown) => ({ error }) as const,
      );
      try {
        await registration;
      } catch {
        if (!cancelled && id === resolutionId)
          setState({
            status: 'error',
            message:
              'This device has been revoked. Use an active device or ask the shop owner to review device access.',
          });
        return;
      }
      const result = await membershipRead;

      try {
        if ('error' in result) throw result.error;
        const membership = result.value;
        if (cancelled || id !== resolutionId) return;
        if (membership) {
          cacheOfflineMembership({
            userId: session.user.id,
            tenantId: membership.tenantId,
            role: membership.role,
            shopIds: membership.shopIds,
          });
          setActive({ status: 'active', session, membership, offline: false });
        } else setState({ status: 'no-tenant', session });
      } catch (error) {
        const errorClass = classifyError(error);
        if (errorClass === 'offline' || errorClass === 'server') {
          const cached = getCachedOfflineMembership(session.user.id);
          if (cached && !cancelled && id === resolutionId) {
            setActive({
              status: 'active',
              session,
              membership: { tenantId: cached.tenantId, role: cached.role, shopIds: cached.shopIds },
              offline: true,
            });
            return;
          }
        }
        setError(error, 'getCurrentMembership failed', id);
      }
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
