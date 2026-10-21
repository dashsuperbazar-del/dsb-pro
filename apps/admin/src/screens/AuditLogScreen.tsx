import { useEffect, useState } from 'preact/hooks';
import {
  AUDIT_PAGE_SIZE,
  AUDIT_TYPES,
  AUDIT_TYPE_LABEL,
  classifyError,
  errorMessage,
  listAuditEvents,
  listTenantUsers,
  type AuditEvent,
  type AuditType,
  type TenantUser,
} from '@dsb-pro/adapters';
import { useSession } from '../lib/useSession';
import { appRoute } from '../lib/paths';
import { auditType, describeAudit } from '../lib/auditLog';

// Read-only list of the events in audit_log that matter for money and access. Only the owner holds
// VIEW_AUDIT_LOG, so RLS (not this screen) is what keeps everyone else out.
export function AuditLogScreen() {
  const session = useSession();
  if (session.status === 'loading') return <p>Loading…</p>;
  if (session.status !== 'active') return <p>Sign in to view the audit log.</p>;
  if (session.membership.role !== 'owner')
    return <p role="alert">Only the owner can view the audit log.</p>;
  return <AuditList />;
}

function AuditList() {
  const [type, setType] = useState<AuditType | ''>('');
  const [userId, setUserId] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [page, setPage] = useState(0);
  const [rows, setRows] = useState<AuditEvent[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [users, setUsers] = useState<TenantUser[]>([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    // Names are a convenience: without them the user id is shown.
    void listTenantUsers()
      .then(setUsers)
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    let live = true;
    setLoading(true);
    setError('');
    listAuditEvents({ type, userId, from, to, page })
      .then((r) => {
        if (!live) return;
        setRows(r.rows);
        setHasMore(r.hasMore);
      })
      .catch((e) => {
        if (!live) return;
        setRows([]);
        setHasMore(false);
        setError(errorMessage(classifyError(e), e));
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, [type, userId, from, to, page]);

  const who = (id: string | null) => {
    if (!id) return 'the system';
    const u = users.find((x) => x.userId === id);
    return u?.displayName || u?.email || `user ${id.slice(0, 8)}`;
  };
  const filter = (apply: () => void) => {
    apply();
    setPage(0);
  };

  return (
    <main class="page wide">
      <p>
        <a href={appRoute.more}>← Shop tools</a>
      </p>
      <h1>Audit log</h1>
      <p class="muted">
        Read-only. Voids, bill edits, credit-limit overrides, price and item changes, customer and
        team changes, newest first. Nothing here can be changed.
      </p>
      <section class="card">
        <div class="grid-form">
          <label>
            Event type
            <select
              value={type}
              onChange={(e) => filter(() => setType(e.currentTarget.value as AuditType | ''))}
            >
              <option value="">All events</option>
              {AUDIT_TYPES.map((t) => (
                <option key={t} value={t}>
                  {AUDIT_TYPE_LABEL[t]}
                </option>
              ))}
            </select>
          </label>
          <label>
            User
            <select value={userId} onChange={(e) => filter(() => setUserId(e.currentTarget.value))}>
              <option value="">Everyone</option>
              {users.map((u) => (
                <option key={u.userId} value={u.userId}>
                  {u.displayName || u.email || u.userId.slice(0, 8)} ({u.role})
                </option>
              ))}
            </select>
          </label>
          <label>
            From
            <input
              type="date"
              value={from}
              max={to || undefined}
              onChange={(e) => filter(() => setFrom(e.currentTarget.value))}
            />
          </label>
          <label>
            To
            <input
              type="date"
              value={to}
              min={from || undefined}
              onChange={(e) => filter(() => setTo(e.currentTarget.value))}
            />
          </label>
        </div>
      </section>
      {error && <p role="alert">{error}</p>}
      {loading && <p role="status">Loading audit log…</p>}
      {!loading && !error && !rows.length && <p class="muted">No events match.</p>}
      {rows.length > 0 && (
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>When</th>
                <th>Type</th>
                <th>By</th>
                <th>What happened</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((e) => {
                const t = auditType(e);
                return (
                  <tr key={e.id}>
                    <td data-label="When">{new Date(e.createdAt).toLocaleString()}</td>
                    <td data-label="Type">{t ? AUDIT_TYPE_LABEL[t] : e.tableName}</td>
                    <td data-label="By">{who(e.userId)}</td>
                    <td data-label="What happened">{describeAudit(e, who)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <div class="row">
        <button type="button" disabled={page === 0 || loading} onClick={() => setPage(page - 1)}>
          Newer
        </button>
        <span class="muted">
          Page {page + 1} · {AUDIT_PAGE_SIZE} per page
        </span>
        <button type="button" disabled={!hasMore || loading} onClick={() => setPage(page + 1)}>
          Older
        </button>
      </div>
    </main>
  );
}
