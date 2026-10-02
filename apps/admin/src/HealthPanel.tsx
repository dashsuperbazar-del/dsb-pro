import { useEffect, useState } from 'preact/hooks';
import { checkInvariants, getLatestBackupHealth, type BackupHealth } from '@dsb-pro/adapters';
import { invariantLabel, invariantRows } from './lib/invariants';

// D4a: every invariant check is listed by name; a failed check is UNKNOWN, never a stale green.

type Integrity = { ok: boolean; rows: { code: string; count: number }[]; checkedAt: Date };

export function HealthPanel() {
  const [backup, setBackup] = useState<BackupHealth | null | undefined>(undefined);
  const [integrity, setIntegrity] = useState<Integrity | null | undefined>(undefined);
  const [backupError, setBackupError] = useState<string | null>(null);
  const [integrityError, setIntegrityError] = useState<string | null>(null);
  useEffect(() => {
    void getLatestBackupHealth()
      .then(setBackup)
      .catch((e: unknown) => {
        setBackup(null);
        setBackupError(e instanceof Error ? e.message : String(e));
      });
    void checkInvariants()
      .then((raw) => {
        const rows = invariantRows(raw);
        // PASS only if the server says ok AND it returned checks AND every count is zero.
        const ok =
          (raw as { ok?: unknown }).ok === true &&
          rows.length > 0 &&
          rows.every((r) => r.count === 0);
        setIntegrity({ ok, rows, checkedAt: new Date() });
      })
      .catch((e: unknown) => {
        setIntegrity(null);
        setIntegrityError(e instanceof Error ? e.message : String(e));
      });
  }, []);
  const backupAgeMs = backup?.finished_at
    ? Date.now() - Date.parse(backup.finished_at)
    : Number.POSITIVE_INFINITY;
  const backupOk =
    backup?.status === 'success' &&
    backupAgeMs >= 0 &&
    backupAgeMs <= 24 * 60 * 60 * 1000 &&
    backup.destinations.length >= 2 &&
    backup.destinations.every((d) => d.verified);
  return (
    <section class="card" aria-label="System health">
      <h2>System health</h2>
      {backupError && (
        <p role="alert" class="alert">
          Backup status unavailable: {backupError}
        </p>
      )}
      {integrityError && (
        <p role="alert" class="alert">
          Invariant check unavailable: {integrityError}
        </p>
      )}
      {backup === undefined ? (
        <p>Loading backup health…</p>
      ) : backup === null ? (
        backupError ? null : (
          <p class="alert">No verified backup has run yet.</p>
        )
      ) : (
        <>
          <p class={backupOk ? 'success' : 'alert'}>
            <strong>Backup:</strong> {backupOk ? 'PASS' : 'ATTENTION'} · {backup.status} ·{' '}
            {backup.finished_at ?? 'never'}
            {backupAgeMs > 24 * 60 * 60 * 1000 ? ' · older than 24 hours' : ''}
          </p>
          <p>
            Destinations:{' '}
            {backup.destinations.length
              ? backup.destinations
                  .map((d) => `${d.name} (${d.verified ? 'verified' : 'unverified'})`)
                  .join(', ')
              : 'none'}
          </p>
        </>
      )}
      {integrity === undefined ? (
        <p>Loading invariant health…</p>
      ) : integrity === null ? (
        <p class="alert" data-testid="invariants-status">
          <strong>Financial invariants:</strong> UNKNOWN — the check could not run.
        </p>
      ) : (
        <>
          <p class={integrity.ok ? 'success' : 'alert'} data-testid="invariants-status">
            <strong>Financial invariants:</strong> {integrity.ok ? 'PASS' : 'FAIL'} · checked{' '}
            {integrity.checkedAt.toLocaleTimeString()} · {integrity.rows.length} checks
          </p>
          <ul aria-label="Invariant checks">
            {integrity.rows.map((r) => (
              <li key={r.code} class={r.count > 0 ? 'alert' : undefined}>
                {invariantLabel(r.code)}: {r.count}
                {r.count > 0 ? ' — FAIL' : ''}
              </li>
            ))}
          </ul>
          {!integrity.ok && (
            <p class="alert">
              <strong>Stop financial posting and investigate before continuing.</strong>
            </p>
          )}
        </>
      )}
    </section>
  );
}
