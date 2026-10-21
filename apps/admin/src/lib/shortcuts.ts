// Desktop keyboard shortcuts. Pure helpers so the rules are testable: a shortcut only MOVES (focus, view) or
// asks for the normal action (Ctrl+Enter = the Finalize button's own handler, with all its checks).
// None of them posts anything by itself.

export type PosShortcut = 'customer' | 'find' | 'payment' | 'cancel' | 'finalize';

type KeyLike = {
  key: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
  isComposing?: boolean;
  defaultPrevented?: boolean;
};

export function posShortcut(ev: KeyLike): PosShortcut | null {
  if (ev.isComposing || ev.defaultPrevented) return null;
  if (ev.altKey || ev.metaKey || ev.shiftKey) return null;
  if (ev.ctrlKey) return ev.key === 'Enter' ? 'finalize' : null;
  switch (ev.key) {
    case 'F2':
      return 'customer';
    case 'F3':
      return 'find';
    case 'F4':
      return 'payment';
    case 'Escape':
      return 'cancel';
    default:
      return null;
  }
}

// A field where the cashier is typing text (Esc there only leaves the field, it never cancels a view).
export function isTypingField(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el || typeof el.tagName !== 'string') return false;
  if (el.isContentEditable) return true;
  if (el.tagName === 'TEXTAREA') return true;
  if (el.tagName !== 'INPUT') return false;
  const type = (el as HTMLInputElement).type;
  return !['checkbox', 'radio', 'button', 'submit', 'reset', 'file'].includes(type);
}

// Index after an arrow key in a list of `count` choices, clamped (no wrap, so a held key stops at the end).
export function stepIndex(current: number, count: number, key: 'ArrowDown' | 'ArrowUp'): number {
  if (count <= 0) return -1;
  if (current < 0) return key === 'ArrowDown' ? 0 : count - 1;
  const next = key === 'ArrowDown' ? current + 1 : current - 1;
  return Math.min(count - 1, Math.max(0, next));
}
