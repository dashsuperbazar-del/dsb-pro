# DW2c — Bill-document backup and disposable restore

Dependent on draft PR #72. No new migration or live operation.

The financial dump and document inventory use the same exported PostgreSQL snapshot. All
bill-documents objects visible in that snapshot are retained, including uploads not yet attached
to a purchase. Every purchase reference, including voided/deleted bill rows, must resolve to a
correctly scoped object. Missing files, size/type mismatch, incomplete downloads, changed source
objects or unavailable credentials refuse a successful backup.

The private archive contains a versioned manifest and content-addressed bytes. It binds the
matching public dump by SHA-256. Nightly backup encrypts the document archive with the existing
age recipient and verifies ciphertext checksums in both existing destinations before recording
success. Each run uses unique filenames to avoid mixing same-day reruns. Source access is read-only.

Restore verifies every local file and the matching public dump before any upload. It requires a
loopback Supabase target, explicit disposable-target acknowledgement, the private bucket settings,
and exactly matching restored purchase references. It never overwrites: an existing/lost-answer
object is accepted only if its downloaded bytes match. Production/hosted restore is deliberately
outside this packet. Existing financial/Auth restore and reconciliation remain separate requirements.
Public-schema restoration also drops file policies that depend on its permission helpers. Restore
recreates only the two reviewed document policies transactionally, preserving the financial RPCs.

Unused-upload reporting is informational. It preserves all original objects and labels unreferenced
uploads as retained; an old unfinished device draft may still need them. No delete API or automatic
purge is added. Report contents are sensitive and belong inside the encrypted archive.

Production activation requires this PR's review/merge plus configured server-only document-download
credentials when objects exist. No new credential is put in the app. This packet's CI proof uses
synthetic data, ephemeral encryption keys and disposable storage only; it does not prove live backup,
physical-key recovery, Android acceptance or attachment disaster recovery in production.

Configure `VITE_SUPABASE_URL` and server-only `SUPABASE_SERVICE_ROLE_KEY` before activating
attachments. An installed bucket requires the correct source URL; nonempty buckets require download
credentials. Missing configuration fails the backup rather than recording an incomplete success.
The nightly record has six verified destination/artifact entries and unique run/attempt filenames.
Private financial aggregates stay in a local file and are removed with the plaintext dumps/files;
they are not exposed as an Actions environment variable. Auth remains a separate existing export.

CI runs the exact nightly encryption, dual-copy/checksum and success-record scripts against ephemeral
keys and two local rclone destinations. It restores financial/Auth data and files to a second
Supabase project, reads as the recovered owner, refuses anonymous public reads, and proves a purchase
committed after export is excluded from the dump while its earlier upload remains retained. This
does not establish production B2/R2 access or a production backup. Full-bucket captures may require
incremental backup at larger volumes; timeout/failure must never be relabelled as success.

Snapshot contract: [PostgreSQL 17 pg_dump](https://www.postgresql.org/docs/17/app-pgdump.html)
and [snapshot synchronization](https://www.postgresql.org/docs/17/functions-admin.html#FUNCTIONS-SNAPSHOT-SYNCHRONIZATION).
