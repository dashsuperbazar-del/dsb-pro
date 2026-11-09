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
 * On touch phones, mark <html class="kbd-open"> while a text field has focus so the
 * fixed bottom nav and sticky Post/total bars step aside and the field stays visible.
 */
export function useKeyboardOpen(): void {
  useEffect(() => {
    if (!window.matchMedia?.('(pointer: coarse)').matches) return;
    const root = document.documentElement;
    const sync = () => {
      const open = isTypingTarget(document.activeElement);
      root.classList.toggle('kbd-open', open);
      if (open) {
        const el = document.activeElement as HTMLElement;
        setTimeout(() => el.scrollIntoView?.({ block: 'center' }), 250);
      }
    };
    const onOut = () => setTimeout(sync, 0);
    document.addEventListener('focusin', sync);
    document.addEventListener('focusout', onOut);
    return () => {
      document.removeEventListener('focusin', sync);
      document.removeEventListener('focusout', onOut);
      root.classList.remove('kbd-open');
    };
  }, []);
}
