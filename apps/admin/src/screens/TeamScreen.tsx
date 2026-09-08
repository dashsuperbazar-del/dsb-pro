import { useEffect, useState } from 'preact/hooks';
import {
  createInvite,
  revokeInvite,
  listInvites,
  listTenantUsers,
  setUserRole,
  isEmailVerified,
  classifyError,
  errorMessage,
  type Invite,
  type Session,
  type TenantUser,
} from '@dsb-pro/adapters';
import { hasPerm, type Role } from '@dsb-pro/core';
import { useSession } from '../lib/useSession';
import { appPath } from '../lib/paths';

const ROLES: Role[] = ['manager', 'cashier', 'accountant'];

export function TeamScreen() {
  const session = useSession();
  const [refreshInvites, setRefreshInvites] = useState(0);

  if (session.status === 'loading') {
    return <p>Loading…</p>;
  }
  if (session.status !== 'active') {
    return <p>Sign in to view your team.</p>;
  }

  const canManageInvites = hasPerm(session.membership.role, 'MANAGE_INVITES');
  const canManageMembers = hasPerm(session.membership.role, 'MANAGE_TENANT_USERS');

  return (
    <main>
      <h1>Team</h1>
      {canManageInvites && (
        <InviteForm session={session.session} onInviteCreated={() => setRefreshInvites((n) => n + 1)} />
      )}
      {canManageInvites && <PendingInvites key={refreshInvites} />}
      <MembersList canManageMembers={canManageMembers} />
    </main>
  );
}

function InviteForm({ session, onInviteCreated }: { session: Session; onInviteCreated: () => void }) {
  const [role, setRole] = useState<Role>('cashier');
  const [link, setLink] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const verified = isEmailVerified(session);

  async function onSubmit(e: Event) {
    e.preventDefault();
    if (!verified) return;
    setError(null);
    try {
      const invite = await createInvite(role);
      setLink(`${window.location.origin}${appPath(`/join/${invite.token}`)}`);
      onInviteCreated();
    } catch (err) {
      setError(errorMessage(classifyError(err), err));
    }
  }

  return (
    <section aria-label="Invite a team member">
      <h2>Invite</h2>
      <form onSubmit={onSubmit}>
        <label>
          Role
          <select value={role} onChange={(e) => setRole((e.target as HTMLSelectElement).value as Role)}>
            {ROLES.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
        </label>
        <button type="submit" disabled={!verified}>
          Create invite
        </button>
      </form>
      {!verified && <p>Verify your email to send invites.</p>}
      {error && <p role="alert">{error}</p>}
      {link && (
        <p>
          Share this link: <span data-testid="invite-link">{link}</span>{' '}
          <a href={`https://wa.me/?text=${encodeURIComponent(link)}`} target="_blank" rel="noreferrer">
            Share on WhatsApp
          </a>
        </p>
      )}
    </section>
  );
}

function PendingInvites() {
  const [invites, setInvites] = useState<Invite[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    listInvites().then(setInvites).catch((err) => setError(errorMessage(classifyError(err), err)));
  }, []);

  async function onRevoke(id: string) {
    setError(null);
    try {
      await revokeInvite(id);
      setInvites((prev) => (prev ? prev.filter((i) => i.id !== id) : prev));
    } catch (err) {
      setError(errorMessage(classifyError(err), err));
    }
  }

  const pending = invites?.filter((i) => new Date(i.expiresAt) > new Date()) ?? [];

  return (
    <section aria-label="Pending invites">
      <h2>Pending invites</h2>
      {error && <p role="alert">{error}</p>}
      <ul data-testid="pending-invites">
        {pending.length === 0 && <li>No pending invites.</li>}
        {pending.map((invite) => (
          <li key={invite.id}>
            {invite.role} — expires {new Date(invite.expiresAt).toLocaleDateString()}{' '}
            <button onClick={() => onRevoke(invite.id)}>Revoke</button>
          </li>
        ))}
      </ul>
    </section>
  );
}

function MembersList({ canManageMembers }: { canManageMembers: boolean }) {
  const [members, setMembers] = useState<TenantUser[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [caveat, setCaveat] = useState(false);

  useEffect(() => {
    listTenantUsers().then(setMembers).catch((err) => setError(errorMessage(classifyError(err), err)));
  }, []);

  async function onRoleChange(userId: string, role: Role) {
    setError(null);
    try {
      await setUserRole(userId, role);
      setMembers((prev) => (prev ? prev.map((m) => (m.userId === userId ? { ...m, role } : m)) : prev));
      setCaveat(true);
    } catch (err) {
      setError(errorMessage(classifyError(err), err));
    }
  }

  return (
    <section aria-label="Team members" data-testid="members-list">
      <h2>Members</h2>
      {error && <p role="alert">{error}</p>}
      {caveat && (
        <p>A role change takes effect on that person's next sign-in — or up to about an hour if they're already signed in.</p>
      )}
      {members === null ? (
        <p>Loading…</p>
      ) : (
        <ul>
          {members.length === 0 && <li>No members yet.</li>}
          {members.map((member) => (
            <li key={member.userId}>
              {member.userId} — {member.status}
              {canManageMembers && member.role !== 'owner' ? (
                <select
                  value={member.role}
                  onChange={(e) => onRoleChange(member.userId, (e.target as HTMLSelectElement).value as Role)}
                >
                  {ROLES.map((r) => (
                    <option key={r} value={r}>
                      {r}
                    </option>
                  ))}
                </select>
              ) : (
                <span> ({member.role})</span>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
