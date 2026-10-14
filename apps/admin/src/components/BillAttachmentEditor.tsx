import { useEffect, useRef, useState } from 'preact/hooks';
import {
  billDocumentHash,
  billDocumentPath,
  readBillDocument,
  uploadBillDocument,
  type BillDocument,
} from '@dsb-pro/adapters';
import { prepareBillDocument } from '../lib/prepareBillDocument';
import { readLocalDocument, saveLocalDocument } from '../lib/billDocumentStore';
import { BillDocumentPreview } from './BillDocumentPreview';

export function BillAttachmentEditor({
  scope,
  tenantId,
  shopId,
  clientId,
  document,
  disabled,
  beforePicker,
  onChange,
  onBusy,
  onProblem,
}: {
  scope: string;
  tenantId: string;
  shopId: string;
  clientId: string;
  document: BillDocument | null;
  disabled: boolean;
  beforePicker: () => boolean;
  onChange: (doc: BillDocument | null) => void;
  onBusy: (busy: boolean) => void;
  onProblem: (message: string) => void;
}) {
  const [blob, setBlob] = useState<Blob | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  const [expanded, setExpanded] = useState(Boolean(document));
  useEffect(() => {
    if (document) setExpanded(true);
  }, [document?.id]);
  const mounted = useRef(true);
  const camera = useRef<HTMLInputElement>(null),
    gallery = useRef<HTMLInputElement>(null),
    pdf = useRef<HTMLInputElement>(null);
  const props = useRef({ onChange, onBusy, onProblem });
  props.current = { onChange, onBusy, onProblem };
  useEffect(
    () => () => {
      mounted.current = false;
    },
    [],
  );
  useEffect(() => {
    setBlob(null);
    setError('');
    if (!document || !scope) return;
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
        if (!document.uploaded && !disabled) {
          await uploadBillDocument(document, local);
          if (active) props.current.onChange({ ...document, uploaded: true });
        }
      } catch (e) {
        if (active) {
          setError(String(e));
          props.current.onProblem(String(e));
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
  }, [scope, document?.id, document?.uploaded, retry, disabled]);
  async function choose(e: Event) {
    const input = e.currentTarget as HTMLInputElement,
      file = input.files?.[0];
    input.value = ''; // Selecting the same file again must still fire change.
    if (!file || disabled || busy || !beforePicker()) return;
    setExpanded(true);
    setBusy(true);
    onBusy(true);
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
      if (mounted.current) onChange(doc); // Parent persists the metadata and complete form before upload.
    } catch (e) {
      if (mounted.current) {
        setError(String(e));
        onProblem(String(e));
      }
    } finally {
      if (mounted.current) {
        setBusy(false);
        onBusy(false);
      }
    }
  }
  function pick(ref: typeof camera) {
    if (!disabled && !busy && beforePicker()) ref.current?.click();
  }
  return (
    <details
      class="bill-attachment"
      open={expanded}
      onToggle={(e) => setExpanded(e.currentTarget.open)}
    >
      <summary>
        Bill photo or PDF{document ? ` · ${document.uploaded ? 'Attached' : 'Upload pending'}` : ''}
      </summary>
      <section aria-label="Bill attachment">
        <p class="muted">
          One document per bill. Photos are compressed for readability; PDFs up to 5 MB. Upload must
          be confirmed before posting.
        </p>
        <div class="context-actions">
          <button type="button" disabled={disabled || busy} onClick={() => pick(camera)}>
            Camera
          </button>
          <button type="button" disabled={disabled || busy} onClick={() => pick(gallery)}>
            Gallery
          </button>
          <button type="button" disabled={disabled || busy} onClick={() => pick(pdf)}>
            Choose PDF
          </button>
        </div>
        <input
          hidden
          ref={camera}
          type="file"
          aria-label="Capture bill photo"
          accept="image/jpeg,image/png,image/webp"
          capture="environment"
          onChange={choose}
          onCancel={() => onProblem('')}
        />
        <input
          hidden
          ref={gallery}
          type="file"
          aria-label="Choose bill image"
          accept="image/jpeg,image/png,image/webp"
          onChange={choose}
          onCancel={() => onProblem('')}
        />
        <input
          hidden
          ref={pdf}
          type="file"
          aria-label="Choose bill PDF"
          accept="application/pdf,.pdf"
          onChange={choose}
          onCancel={() => onProblem('')}
        />
        {busy && <p aria-live="polite">Saving or checking document… Keep this page open.</p>}
        {error && <p role="alert">{error}</p>}
        {document && (
          <>
            <p>
              {document.name} · {Math.ceil(document.size / 1024)} KB ·{' '}
              {document.uploaded ? 'Upload confirmed' : 'Upload not confirmed'}
            </p>
            <div class="context-actions">
              {blob && <BillDocumentPreview blob={blob} name={document.name} />}
              {!document.uploaded && (
                <button
                  type="button"
                  disabled={disabled || busy}
                  onClick={() => setRetry((n) => n + 1)}
                >
                  Retry document upload
                </button>
              )}
              <button
                type="button"
                disabled={disabled || busy}
                onClick={() => {
                  if (
                    confirm(
                      'Remove this attachment from the unposted draft? The stored original is retained.',
                    )
                  )
                    onChange(null);
                }}
              >
                Remove attachment
              </button>
            </div>
          </>
        )}
      </section>
    </details>
  );
}
