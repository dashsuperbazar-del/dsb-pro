import { useEffect, useState } from 'preact/hooks';
import {
  createInvite,
  revokeInvite,
  listInvites,
  listTenantUsers,
  setUserRole,
  setUserStatus,
  removeTenantUser,
  isEmailVerified,
  classifyError,
  errorMessage,
  type Invite,
  type Session,
  type TenantUser,
} from '@dsb-pro/adapters';
import { type Role } from '@dsb-pro/core';
import { useSession } from '../lib/useSession';
import { appPath } from '../lib/paths';

const ROLES: Role[] = ['manager', 'cashier', 'accountant'];

export function TeamScreen() {
  const session = useSession();
  const [refreshInvites, setRefreshInvites] = useState(0);

  if (session.status === 'loading') return <p>Loading…</p>;
  if (session.status !== 'active') return <p>Sign in to view your team.</p>;
  if (session.membership.role !== 'owner') return <p role="alert">Only the owner can manage the team.</p>;

  return (
    <main>
      <h1>Team</h1>
      <InviteForm session={session.session} onInviteCreated={() => setRefreshInvites((n) => n + 1)} />
      <PendingInvites key={refreshInvites} />
      <MembersList />
    </main>
  );
}

function InviteForm({ session, onInviteCreated }: { session: Session; onInviteCreated: () => void }) {
  const [role, setRole] = useState<Role>('cashier');
  const [link, setLink] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const verified = isEmailVerified(session);

  async function onSubmit(e: Event) {
    e.preventDefault();
    if (!verified) return;
    setError(null);
    setCopied(false);
    try {
      const invite = await createInvite(role);
      setLink(`${window.location.origin}${appPath(`/join/${invite.token}`)}`);
      onInviteCreated();
    } catch (err) {
      setError(errorMessage(classifyError(err), err));
    }
  }

  async function copyLink() {
    if (!link) return;
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
    } catch {
      setError('Unable to copy the invite link.');
    }
  }

  return (
    <section aria-label="Invite a team member">
      <h2>Invite</h2>
      <form onSubmit={onSubmit}>
        <label>
          Role
          <select value={role} onChange={(e) => setRole((e.target as HTMLSelectElement).value as Role)}>
            {ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
          </select>
        </label>
        <button type="submit" disabled={!verified}>Create invite</button>
      </form>
      {!verified && <p>Verify your email to send invites.</p>}
      {error && <p role="alert">{error}</p>}
      {link && (
        <p>
          Share this link: <span data-testid="invite-link">{link}</span>{' '}
          <button type="button" onClick={() => void copyLink()}>Copy link</button>{' '}
          <a href={`https://wa.me/?text=${encodeURIComponent(link)}`} target="_blank" rel="noreferrer">Share on WhatsApp</a>
          {copied && <span role="status"> Copied.</span>}
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
            Code {invite.token} — {invite.role} — created {new Date(invite.createdAt).toLocaleDateString()} — expires{' '}
            {new Date(invite.expiresAt).toLocaleDateString()}{' '}
            <button onClick={() => onRevoke(invite.id)}>Revoke</button>
          </li>
        ))}
      </ul>
    </section>
  );
}

function MembersList() {
  const [members, setMembers] = useState<TenantUser[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    listTenantUsers().then(setMembers).catch((err) => setError(errorMessage(classifyError(err), err)));
  }, []);

  async function onRoleChange(userId: string, role: Role) {
    setError(null);
    try {
      await setUserRole(userId, role);
      setMembers((prev) => (prev ? prev.map((m) => (m.userId === userId ? { ...m, role } : m)) : prev));
    } catch (err) {
      setError(errorMessage(classifyError(err), err));
    }
  }

  async function onStatusChange(member: TenantUser) {
    const status = member.status === 'active' ? 'disabled' : 'active';
    setError(null);
    try {
      await setUserStatus(member.userId, status);
      setMembers((prev) => (prev ? prev.map((m) => (m.userId === member.userId ? { ...m, status } : m)) : prev));
    } catch (err) {
      setError(errorMessage(classifyError(err), err));
    }
  }

  async function onRemove(userId: string) {
    setError(null);
    try {
      await removeTenantUser(userId);
      setMembers((prev) => (prev ? prev.filter((m) => m.userId !== userId) : prev));
    } catch (err) {
      setError(errorMessage(classifyError(err), err));
    }
  }

  return (
    <section aria-label="Team members" data-testid="members-list">
      <h2>Members</h2>
      {error && <p role="alert">{error}</p>}
      {members === null ? <p>Loading…</p> : (
        <ul>
          {members.length === 0 && <li>No members yet.</li>}
          {members.map((member) => (
            <li key={member.userId}>
              {member.displayName ?? member.email ?? member.userId} — {member.status}{' '}
              {member.role !== 'owner' ? (
                <>
                  <select aria-label={`Role for ${member.email ?? member.userId}`} value={member.role} onChange={(e) => void onRoleChange(member.userId, (e.target as HTMLSelectElement).value as Role)}>
                    {ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
                  </select>{' '}
                  <button type="button" onClick={() => void onStatusChange(member)}>
                    {member.status === 'active' ? 'Disable' : 'Reactivate'}
                  </button>{' '}
                  <button type="button" onClick={() => void onRemove(member.userId)}>Remove</button>
                </>
              ) : <span> ({member.role})</span>}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
