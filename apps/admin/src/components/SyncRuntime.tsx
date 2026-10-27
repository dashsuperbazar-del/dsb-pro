import { useEffect, useRef } from 'preact/hooks';
import type { SessionState } from '../lib/useSession';
import { startOfflineSync, stopOfflineSync } from '../lib/offlineSync';

export function SyncRuntime({ session }: { session: SessionState }) {
  const active = session.status === 'active';
  const userId = session.status === 'active' ? session.session.user.id : '';
  const tenantId = session.status === 'active' ? session.membership.tenantId : '';
  const role = session.status === 'active' ? session.membership.role : '';
  const shops = session.status === 'active' ? session.membership.shopIds.join(',') : '';
  // One loop per user + shop group. A role or shop change (the server answering differently from the
  // cached membership the app opened with) updates the RUNNING loop in place: it is never restarted, so
  // an in-flight send is not interrupted and no second loop can appear.
  const latest = useRef(session);
  latest.current = session;
  const started = useRef('');
  useEffect(() => {
    if (!active) {
      started.current = '';
      stopOfflineSync();
      return;
    }
    started.current = `${role}|${shops}`;
    void startOfflineSync({ userId, membership: membershipOf(latest.current) });
    return () => stopOfflineSync();
  }, [active, userId, tenantId]);
  useEffect(() => {
    if (!active || started.current === `${role}|${shops}`) return;
    started.current = `${role}|${shops}`;
    void startOfflineSync({ userId, membership: membershipOf(latest.current) });
  }, [role, shops]);
  return null;
}

function membershipOf(session: SessionState) {
  if (session.status !== 'active') throw new Error('not active');
  return session.membership;
}
