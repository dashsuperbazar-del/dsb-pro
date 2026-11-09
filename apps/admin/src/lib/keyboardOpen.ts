import { useEffect } from 'preact/hooks';

const TEXT_TYPES = /^(text|search|tel|number|email|url|password|date|time|datetime-local|month)$/;

/** True when focus is in a field that brings up the on-screen keyboard. */
export function isTypingTarget(el: Element | null): boolean {
  if (!el) return false;
  if (el instanceof HTMLTextAreaElement) return !el.readOnly;
  if (el instanceof HTMLInputElement) return !el.readOnly && TEXT_TYPES.test(el.type || 'text');
  return (el as HTMLElement).isContentEditable === true;
}

/**
 * On touch phones, mark <html class="kbd-open"> only while a text field has focus AND the visible
 * screen has really shrunk (an on-screen keyboard is up), so the fixed bottom nav and sticky
 * Post/total bars step aside. No keyboard (desktop, hardware keyboard, tests) = nothing changes.
 */
export function useKeyboardOpen(): void {
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv || !window.matchMedia?.('(pointer: coarse)').matches) return;
    const root = document.documentElement;
    let full = Math.max(window.innerHeight, vv.height);
    const sync = () => {
      const h = vv.height;
      const typing = isTypingTarget(document.activeElement);
      if (!typing) full = Math.max(window.innerHeight, h);
      root.classList.toggle('kbd-open', typing && h < full * 0.8);
    };
    const later = () => setTimeout(sync, 0);
    vv.addEventListener('resize', sync);
    document.addEventListener('focusin', sync);
    document.addEventListener('focusout', later);
    return () => {
      vv.removeEventListener('resize', sync);
      document.removeEventListener('focusin', sync);
      document.removeEventListener('focusout', later);
      root.classList.remove('kbd-open');
    };
  }, []);
}
