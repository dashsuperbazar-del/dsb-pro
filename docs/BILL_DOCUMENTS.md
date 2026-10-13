# DW2b — Private bill attachments

Base: PR #71 `3169f882f404c4f328267402f52cf661e157fdc7`; this is a dependent draft packet.
Main remains `41dfd4b`. Do not merge this packet ahead of draft recovery.

## Behaviour

One image or PDF per purchase. Camera, Gallery and PDF inputs are separate; picking the same file
again is supported. The complete current form is saved before opening the picker. Prepared binary
bytes are committed to user/shop-scoped IndexedDB before metadata is saved and upload begins.
Reload resumes the same file/path and posting identity. A missing local pending file is explicit;
it is not silently removed. Posting waits for a confirmed upload or explicit removal.

Photos become WebP (up to 2400px long edge, 1 MB, quality floor 0.77); unreadably large images are
refused with crop/scan guidance. PDFs retain original bytes, up to 5 MB. File types/signatures are
checked locally; SVG/HTML and empty files are refused. A floating photo view has zoom, pointer/arrow
movement, Escape/Close and viewport bounds. PDF opens/downloads from authenticated bytes. Downloads
use the actual MIME extension. Bill history fetches the stored path and opens the protected original.
Repeat copies financial draft fields, never the old document.

An upload whose answer is lost is confirmed only when bytes at the same immutable path have the
same size and SHA-256. It never overwrites. New purchase RPCs include the confirmed path; UNKNOWN
retries keep it exactly. Definitive rejection retains the posting identity inherited from DW2a.
Async completions cannot attach to a different active request. Separate photo IDs preserve parallel
editor snapshots; confirmed purchases can release their local copy because the server original remains.

## Server boundary

Migration `0058_bill_documents.sql`, group `billdocs`, creates private `bill-documents` storage.
Read: permitted supplier-purchase/report roles and shop scope. Insert: POST_PURCHASES and permitted
shop in the current tenant. No client UPDATE/DELETE policy; item-image rights do not expose bills.
Paths bind tenant/shop/request/photo IDs. `post_purchase` keeps its signature, grants, C0 finance lock,
C3b payload compare and canonical calculation body. New paths require the correct shop/request and
an existing stored object with accepted MIME/size. Null cannot remove an attachment on retry.
No public tables, columns or RPC signatures change; generated public DB types should remain identical.

The receipt registry/apply/classifier/attended CI path includes billdocs. The old 19-part observed
state is preserved; billdocs gets explicit state/needs fields. Partial anchors, checksum drift, public
bucket drift and altered purchase-wrapper body refuse. CI applies the group on a disposable Phase-5
upgrade path and verifies no-op/tamper refusal; live apply stays workflow_dispatch-only from main.

## Evidence and limits

- Local lint/types, 336 unit tests, production build, formatting, bundle and installability: PASS.
- Adapter tests cover role/tenant/shop isolation, immutable uploads and lost answers with same-size
  different bytes. Local binary tests cover exact reopen/scoping, overwrite refusal, unavailable
  storage and PDF/type/size validation. DOM proof keeps the full draft durable before uploading,
  blocks posting, reloads a pending attachment with the same path, and posts the exact bound request.
- 17 pgTAP cases: missing/wrong-request binding, no liability on failure, exact/null retry, stock once,
  immutable/private storage, cashier/other tenant denial and assigned/unassigned accountant scope.
- Existing 390px reconciliation now uploads a synthetic photo while dropping its answer, reloads
  an unfinished edit, views/moves/zooms the recovered photo, posts it, views it from history, repeats
  without copying the old file, uploads a PDF, verifies downloaded PDF bytes and reconciles payments/stock.
- Database/browser/upgrade evidence is pending full CI. Local Docker/psql/Chromium unavailable.
- Independent review and second validate-only migration run remain pending. No merge, live migration,
  deployment, actual Android camera/picker/process-eviction or real-shop acceptance claimed.

Binary originals are outside the existing finance/Auth dump backup. Object-byte backup/restore and
unused-object retention cleanup remain follow-up work before claiming attachment disaster recovery.
Browser data clearing loses unsent local drafts/files; this is continuity, not a backup. Failed/replaced
unposted uploads can remain as private orphan objects because immutable retention is deliberately safer
than racing deletion with a purchase. Multiple attachments and statement/receipt sharing are later work.
