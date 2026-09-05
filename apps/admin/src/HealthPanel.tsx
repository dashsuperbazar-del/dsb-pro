import { useEffect, useState } from 'preact/hooks';

// Talks to PostgREST directly rather than pulling in @supabase/supabase-js:
// this is one read-only, non-financial call outside the sync system, so
// staying off the provider SDK keeps Phase 0 aligned with the "providers
// only behind adapters" rule until Phase 1 actually builds that layer.
const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL;
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY;

type BackupStatus = {
  status: string;
  finished_at: string | null;
  destinations: { name: string; verified: boolean }[];
  app_version: string | null;
  schema_version: number | null;
};

export function HealthPanel() {
  const [backup, setBackup] = useState<BackupStatus | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch(`${SUPABASE_URL}/rest/v1/rpc/get_latest_backup_status`, {
      method: 'POST',
      headers: {
        apikey: SUPABASE_ANON_KEY,
        Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
        'Content-Type': 'application/json',
      },
      body: '{}',
    })
      .then(async (res) => {
        if (!res.ok) {
          throw new Error(`${res.status} ${await res.text()}`);
        }
        return res.json() as Promise<BackupStatus[]>;
      })
      .then((rows) => setBackup(rows[0] ?? null))
      .catch((err: Error) => setError(err.message));
  }, []);

  if (error) {
    return <p role="alert">Backup status unavailable: {error}</p>;
  }

  if (backup === undefined) {
    return <p>Loading backup status…</p>;
  }

  if (backup === null) {
    return <p>No backup has run yet.</p>;
  }

  return (
    <section aria-label="Backup health">
      <h2>Backup</h2>
      <p>Status: {backup.status}</p>
      <p>Last finished: {backup.finished_at ?? 'never'}</p>
      <p>
        Destinations:{' '}
        {backup.destinations.length
          ? backup.destinations.map((d) => `${d.name} (${d.verified ? 'verified' : 'unverified'})`).join(', ')
          : 'none yet'}
      </p>
    </section>
  );
}
