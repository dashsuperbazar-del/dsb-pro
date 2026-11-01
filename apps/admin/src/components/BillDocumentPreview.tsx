import { errorText } from '../lib/friendlyError';
import { useEffect, useRef, useState } from 'preact/hooks';
import { readBillDocument } from '@dsb-pro/adapters';

// P13: the viewer keeps its last position and width on this device (old DSB savePeekGeom). A convenience
// only: unreadable or blocked storage just means the default place and size.
const GEOM_KEY = 'dsb-bill-peek-geom';
type Geom = { x: number; y: number; w: number };
function readGeom(): Geom | null {
  try {
    const g = JSON.parse(localStorage.getItem(GEOM_KEY) ?? 'null') as Geom | null;
    return g && [g.x, g.y, g.w].every((v) => Number.isFinite(v)) ? g : null;
  } catch {
    return null;
  }
}
function saveGeom(g: Geom) {
  try {
    localStorage.setItem(GEOM_KEY, JSON.stringify(g));
  } catch {
    // ignore: storage blocked or full
  }
}

export function BillDocumentPreview({
  blob,
  path,
  name = 'Bill document',
}: {
  blob?: Blob | null;
  path?: string | null;
  name?: string;
}) {
  const [open, setOpen] = useState(false);
  const [url, setUrl] = useState('');
  const [mime, setMime] = useState('');
  const [error, setError] = useState('');
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [zoom, setZoom] = useState(1);
  const [width, setWidth] = useState(() => readGeom()?.w ?? 420);
  const [viewport, setViewport] = useState({ width: innerWidth, height: innerHeight });
  const panel = useRef<HTMLDivElement>(null);
  const drag = useRef<{ x: number; y: number; dx: number; dy: number } | null>(null);
  useEffect(() => {
    if (!open) return;
    let active = true;
    let objectUrl = '';
    setError('');
    setUrl('');
    setZoom(1);
    void (async () => {
      try {
        const file = blob ?? (path ? await readBillDocument(path) : null);
        if (!file) throw new Error('Bill document is unavailable.');
        if (!active) return;
        objectUrl = URL.createObjectURL(file);
        setMime(file.type);
        setUrl(objectUrl);
      } catch (e) {
        if (active) setError(errorText(e));
      }
    })();
    return () => {
      active = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [open, blob, path]);
  useEffect(() => {
    if (!open) return;
    const close = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    const reset = () => {
      const saved = readGeom();
      setOffset(saved ? { x: saved.x, y: saved.y } : { x: 0, y: 0 });
      setViewport({
        width: window.visualViewport?.width ?? innerWidth,
        height: window.visualViewport?.height ?? innerHeight,
      });
    };
    reset();
    window.addEventListener('keydown', close);
    window.addEventListener('resize', reset);
    window.visualViewport?.addEventListener('resize', reset);
    return () => {
      window.removeEventListener('keydown', close);
      window.removeEventListener('resize', reset);
      window.visualViewport?.removeEventListener('resize', reset);
    };
  }, [open]);
  // Remember where the user left it (drag, arrow keys or size buttons) for the next bill.
  useEffect(() => {
    if (open) saveGeom({ ...offset, w: width });
  }, [open, offset, width]);
  function move(x: number, y: number) {
    const bounds = panel.current?.getBoundingClientRect();
    const width = window.visualViewport?.width ?? innerWidth;
    const height = window.visualViewport?.height ?? innerHeight;
    if (!bounds) return;
    setOffset((old) => ({
      x: Math.max(old.x - bounds.left + 8, Math.min(x, old.x + width - bounds.right - 8)),
      y: Math.max(old.y - bounds.top + 8, Math.min(y, old.y + height - bounds.bottom - 8)),
    }));
  }
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        View bill document
      </button>
      {open && (
        <div
          class="bill-photo-panel"
          role="dialog"
          aria-label="Bill document viewer"
          ref={panel}
          style={{
            transform: `translate(${offset.x}px, ${offset.y}px)`,
            width: `${Math.max(200, Math.min(width, viewport.width - 24))}px`,
            maxHeight: `${Math.max(120, viewport.height - 24)}px`,
          }}
        >
          <div class="bill-photo-toolbar">
            <button
              type="button"
              aria-label="Move bill viewer"
              onPointerDown={(e) => {
                e.currentTarget.setPointerCapture(e.pointerId);
                drag.current = { x: e.clientX, y: e.clientY, dx: offset.x, dy: offset.y };
              }}
              onPointerMove={(e) => {
                if (drag.current)
                  move(
                    drag.current.dx + e.clientX - drag.current.x,
                    drag.current.dy + e.clientY - drag.current.y,
                  );
              }}
              onPointerUp={() => {
                drag.current = null;
              }}
              onPointerCancel={() => {
                drag.current = null;
              }}
              onKeyDown={(e) => {
                const delta = e.shiftKey ? 40 : 10;
                if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) {
                  e.preventDefault();
                  move(
                    offset.x +
                      (e.key === 'ArrowLeft' ? -delta : e.key === 'ArrowRight' ? delta : 0),
                    offset.y + (e.key === 'ArrowUp' ? -delta : e.key === 'ArrowDown' ? delta : 0),
                  );
                }
              }}
            >
              Move ↔
            </button>
            <strong>{name}</strong>
            <button
              type="button"
              aria-label="Make bill viewer smaller"
              onClick={() => {
                setWidth((w) => Math.max(200, w - 60));
              }}
            >
              −
            </button>
            <button
              type="button"
              aria-label="Make bill viewer larger"
              onClick={() => {
                setWidth((w) => Math.min(900, w + 60));
              }}
            >
              +
            </button>
            <button type="button" onClick={() => setOpen(false)} aria-label="Close bill viewer">
              Close
            </button>
          </div>
          {error && <p role="alert">{error}</p>}
          {!url && !error && <p>Opening document…</p>}
          {url && (
            <>
              {mime === 'application/pdf' ? (
                <p>
                  PDF bill ·{' '}
                  <a href={url} target="_blank" rel="noopener noreferrer">
                    Open PDF
                  </a>
                </p>
              ) : (
                <div class="bill-photo-image">
                  <img
                    src={url}
                    alt="Attached supplier bill"
                    style={{ width: `${zoom * 100}%`, maxWidth: 'none' }}
                  />
                </div>
              )}
              <div class="context-actions">
                {mime !== 'application/pdf' && (
                  <>
                    <button type="button" onClick={() => setZoom((z) => Math.min(4, z + 0.25))}>
                      Zoom in
                    </button>
                    <button type="button" onClick={() => setZoom((z) => Math.max(1, z - 0.25))}>
                      Zoom out
                    </button>
                  </>
                )}
                <a
                  href={url}
                  download={
                    name.replace(/\.[^.]+$/, '') +
                    (mime === 'application/pdf'
                      ? '.pdf'
                      : mime === 'image/jpeg'
                        ? '.jpg'
                        : mime === 'image/png'
                          ? '.png'
                          : '.webp')
                  }
                >
                  Download document
                </a>
              </div>
            </>
          )}
        </div>
      )}
    </>
  );
}
