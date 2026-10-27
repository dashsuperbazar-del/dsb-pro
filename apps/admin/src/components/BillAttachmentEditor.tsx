import { errorText } from '../lib/friendlyError';
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import {
  billDocumentHash,
  billDocumentPath,
  readBillDocument,
  uploadBillDocument,
  type BillDocument,
} from '@dsb-pro/adapters';
import { prepareBillDocument } from '../lib/prepareBillDocument';
import { readLocalDocument, saveLocalDocument } from '../lib/billDocumentStore';
import { MAX_BILL_PHOTOS } from '../lib/billExtras';
import { BillDocumentPreview } from './BillDocumentPreview';

// Bill photos/PDFs of one unposted bill (old DSB "Bill Image" strip, up to 10). Every file follows the
// private bill-document flow (docs/BILL_DOCUMENTS.md): bytes are kept on the device first, the parent
// persists the metadata with the draft, then the file is uploaded to an immutable path bound to
// tenant/shop/bill request id/file id. A file is never overwritten; a lost upload answer is confirmed only by
// identical bytes. The first file is also the bill's document (bill_image_path).
export function BillAttachmentEditor({
  scope,
  tenantId,
  shopId,
  clientId,
  documents,
  disabled,
  beforePicker,
  deferUpload,
  deferNote,
  labelSuffix = '',
  onChange,
  onBusy,
  onProblem,
}: {
  scope: string;
  tenantId: string;
  shopId: string;
  clientId: string;
  documents: BillDocument[];
  disabled: boolean;
  beforePicker: () => boolean;
  /** Quick bill: keep the bytes on the device and upload only after the draft that records them is saved. */
  deferUpload?: boolean;
  /** Shown instead of the quick-bill wording while uploads are deferred (offline purchases). */
  deferNote?: string;
  /** Added to the accessible names so two editors on one page stay distinguishable. */
  labelSuffix?: string;
  /** Persist the new list (the draft) before it is shown; throw to refuse it. */
  onChange: (docs: BillDocument[]) => void;
  onBusy: (busy: boolean) => void;
  onProblem: (message: string) => void;
}) {
  const [picking, setPicking] = useState(false);
  const [busyIds, setBusyIds] = useState<string[]>([]);
  const [error, setError] = useState('');
  const [expanded, setExpanded] = useState(documents.length > 0);
  useEffect(() => {
    if (documents.length) setExpanded(true);
  }, [documents.length]);
  const mounted = useRef(true);
  const camera = useRef<HTMLInputElement>(null),
    gallery = useRef<HTMLInputElement>(null),
    pdf = useRef<HTMLInputElement>(null);
  const props = useRef({ onChange, onBusy, onProblem, documents });
  props.current = { onChange, onBusy, onProblem, documents };
  useEffect(
    () => () => {
      mounted.current = false;
    },
    [],
  );
  // Two uploads may confirm before the next render: each change builds on the last list sent.
  function emit(next: BillDocument[]) {
    props.current.onChange(next);
    props.current.documents = next;
  }
  const busy = picking || busyIds.length > 0;
  // Layout effect: the screen learns "not busy" before the buttons can be pressed again, so a pick is
  // never refused by a stale busy flag.
  useLayoutEffect(() => props.current.onBusy(busy), [busy]);
  const full = documents.length >= MAX_BILL_PHOTOS;
  async function choose(e: Event) {
    const input = e.currentTarget as HTMLInputElement,
      file = input.files?.[0];
    input.value = ''; // Selecting the same file again must still fire change.
    if (!file || disabled || busy || full || !beforePicker()) return;
    setExpanded(true);
    setPicking(true);
    setError('');
    try {
      const body = await prepareBillDocument(file);
      if (!mounted.current) return;
      const id = crypto.randomUUID();
      const doc: BillDocument = {
        id,
        name: file.name,
        mime: body.type as BillDocument['mime'],
        size: body.size,
        sha256: await billDocumentHash(body),
        path: billDocumentPath(tenantId, shopId, clientId, id, body.type),
        uploaded: false,
      };
      await saveLocalDocument(scope, id, body);
      // Parent persists the metadata and complete form before upload.
      if (mounted.current) emit([...props.current.documents, doc]);
    } catch (e) {
      if (mounted.current) {
        setError(errorText(e));
        onProblem(errorText(e));
      }
    } finally {
      if (mounted.current) setPicking(false);
    }
  }
  function pick(ref: typeof camera) {
    if (!disabled && !busy && !full && beforePicker()) ref.current?.click();
  }
  const uploaded = documents.filter((d) => d.uploaded).length;
  return (
    <details
      class="bill-attachment"
      open={expanded}
      onToggle={(e) => setExpanded(e.currentTarget.open)}
    >
      <summary>
        Bill photos or PDF
        {documents.length
          ? ` · ${documents.length} ${uploaded === documents.length ? 'attached' : `added, ${documents.length - uploaded} ${deferUpload ? (deferNote ? 'kept on this device, upload when the bill syncs' : 'kept on this device, upload when the draft is opened') : 'upload pending'}`}`
          : ''}
      </summary>
      <section aria-label={labelSuffix ? 'Quick bill photo attachment' : 'Bill attachment'}>
        <p class="muted">
          Up to {MAX_BILL_PHOTOS} photos or PDFs per bill. Photos are compressed for readability;
          PDFs up to 5 MB. Each upload must be confirmed before posting.
        </p>
        <div class="context-actions">
          <button type="button" disabled={disabled || busy || full} onClick={() => pick(camera)}>
            Camera
          </button>
          <button type="button" disabled={disabled || busy || full} onClick={() => pick(gallery)}>
            Gallery
          </button>
          <button type="button" disabled={disabled || busy || full} onClick={() => pick(pdf)}>
            Choose PDF
          </button>
        </div>
        {full && <p class="muted">{MAX_BILL_PHOTOS} files attached, the most a bill can carry.</p>}
        <input
          hidden
          ref={camera}
          type="file"
          aria-label={`Capture bill photo${labelSuffix}`}
          accept="image/jpeg,image/png,image/webp"
          capture="environment"
          onChange={choose}
          onCancel={() => onProblem('')}
        />
        <input
          hidden
          ref={gallery}
          type="file"
          aria-label={`Choose bill image${labelSuffix}`}
          accept="image/jpeg,image/png,image/webp"
          onChange={choose}
          onCancel={() => onProblem('')}
        />
        <input
          hidden
          ref={pdf}
          type="file"
          aria-label={`Choose bill PDF${labelSuffix}`}
          accept="application/pdf,.pdf"
          onChange={choose}
          onCancel={() => onProblem('')}
        />
        {busy && <p aria-live="polite">Saving or checking document… Keep this page open.</p>}
        {error && <p role="alert">{error}</p>}
        {documents.map((doc, i) => (
          <AttachmentRow
            key={doc.id}
            n={i + 1}
            scope={scope}
            document={doc}
            disabled={disabled}
            deferUpload={deferUpload}
            deferNote={deferNote}
            labelSuffix={labelSuffix}
            onBusy={(on) =>
              setBusyIds((ids) =>
                on
                  ? ids.includes(doc.id)
                    ? ids
                    : [...ids, doc.id]
                  : ids.filter((x) => x !== doc.id),
              )
            }
            onProblem={(m) => props.current.onProblem(m)}
            onUploaded={() =>
              emit(
                props.current.documents.map((d) =>
                  d.id === doc.id ? { ...d, uploaded: true } : d,
                ),
              )
            }
            onRemove={() => {
              if (
                confirm('Remove this file from the unposted bill? The stored original is retained.')
              )
                emit(props.current.documents.filter((d) => d.id !== doc.id));
            }}
          />
        ))}
      </section>
    </details>
  );
}

function AttachmentRow({
  n,
  scope,
  document,
  disabled,
  deferUpload,
  deferNote,
  labelSuffix,
  onBusy,
  onProblem,
  onUploaded,
  onRemove,
}: {
  n: number;
  scope: string;
  document: BillDocument;
  disabled: boolean;
  deferUpload?: boolean;
  deferNote?: string;
  labelSuffix: string;
  onBusy: (busy: boolean) => void;
  onProblem: (message: string) => void;
  onUploaded: () => void;
  onRemove: () => void;
}) {
  const [blob, setBlob] = useState<Blob | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  const props = useRef({ onBusy, onProblem, onUploaded });
  props.current = { onBusy, onProblem, onUploaded };
  useEffect(() => () => props.current.onBusy(false), []);
  useEffect(() => {
    setBlob(null);
    setError('');
    if (!scope) return;
    let active = true;
    setBusy(true);
    props.current.onBusy(true);
    void (async () => {
      try {
        let local = await readLocalDocument(scope, document.id);
        if (!local && document.uploaded) local = await readBillDocument(document.path);
        if (!local)
          throw new Error(
            'Saved document bytes are unavailable. Select the original file again or explicitly remove the attachment.',
          );
        if ((await billDocumentHash(local)) !== document.sha256)
          throw new Error(
            'Saved document bytes changed. The attachment has been kept; select the original again.',
          );
        if (!active) return;
        setBlob(local);
        if (!document.uploaded && !disabled && !deferUpload) {
          await uploadBillDocument(document, local);
          if (active) props.current.onUploaded();
        }
      } catch (e) {
        if (active) {
          setError(errorText(e));
          props.current.onProblem(errorText(e));
        }
      } finally {
        if (active) {
          setBusy(false);
          props.current.onBusy(false);
        }
      }
    })();
    return () => {
      active = false;
    };
  }, [scope, document.id, document.uploaded, retry, disabled, deferUpload]);
  return (
    <div class="bill-attachment-row" data-testid={`bill-photo-${n}${labelSuffix ? '-quick' : ''}`}>
      <p>
        {n}. {document.name} · {Math.ceil(document.size / 1024)} KB ·{' '}
        {document.uploaded
          ? 'Upload confirmed'
          : deferUpload
            ? (deferNote ?? 'Kept on this device; uploads when you open the saved draft')
            : 'Upload not confirmed'}
      </p>
      {error && <p role="alert">{error}</p>}
      <div class="context-actions">
        {blob && <BillDocumentPreview blob={blob} name={document.name} />}
        {!document.uploaded && !deferUpload && (
          <button type="button" disabled={disabled || busy} onClick={() => setRetry((r) => r + 1)}>
            Retry document upload
          </button>
        )}
        <button
          type="button"
          aria-label={`Remove file ${n}${labelSuffix}`}
          disabled={disabled || busy}
          onClick={onRemove}
        >
          Remove attachment
        </button>
      </div>
    </div>
  );
}
