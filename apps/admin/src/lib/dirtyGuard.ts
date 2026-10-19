import { useEffect, useState } from 'preact/hooks';

// N08 dirty-entry guard (old DSB guardedCloseBill/guardedCloseInvoice). Entry editors register while they
// hold typed input that is not yet saved as a draft. While any is dirty, closing the tab or following an in-app
// link asks first. It never deletes saved purchase drafts; they stay in "Saved purchase drafts".
export const DISCARD_PROMPT = 'Discard unsaved entry?';

const dirty = new Set<symbol>();

function onBeforeUnload(e: BeforeUnloadEvent) {
  if (!dirty.size) return;
  e.preventDefault();
  e.returnValue = '';
}

// Capture phase, so a declined leave is stopped before preact-router's link handler routes.
function onClickCapture(e: MouseEvent) {
  if (!dirty.size || e.defaultPrevented || e.button !== 0) return;
  if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
  const link = (e.target as Element | null)?.closest?.('a[href]') as HTMLAnchorElement | null;
  if (!link || link.hasAttribute('download')) return;
  if (link.target && link.target !== '_self') return;
  const to = new URL(link.href, location.href);
  if (to.origin !== location.origin) return;
  if (to.pathname === location.pathname && to.search === location.search) return;
  if (!window.confirm(DISCARD_PROMPT)) {
    e.preventDefault();
    e.stopImmediatePropagation();
  }
}

export function setDirty(key: symbol, value: boolean) {
  const before = dirty.size;
  if (value) dirty.add(key);
  else dirty.delete(key);
  if (!before && dirty.size) {
    window.addEventListener('beforeunload', onBeforeUnload);
    document.addEventListener('click', onClickCapture, true);
  } else if (before && !dirty.size) {
    window.removeEventListener('beforeunload', onBeforeUnload);
    document.removeEventListener('click', onClickCapture, true);
  }
}

/** True when nothing is dirty or the user agrees to discard. */
export function confirmDiscard(): boolean {
  return !dirty.size || window.confirm(DISCARD_PROMPT);
}

export function useDirtyGuard(isDirty: boolean) {
  const [key] = useState(() => Symbol('dirty-entry'));
  useEffect(() => {
    setDirty(key, isDirty);
  }, [isDirty]);
  useEffect(() => () => setDirty(key, false), []);
}
