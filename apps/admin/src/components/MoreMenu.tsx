import { useEffect, useRef, useState } from 'preact/hooks';

export type MoreItem = { label: string; onSelect: () => void; danger?: boolean; disabled?: boolean };

// Per-row "More" menu: an accessible menu button. Closes on Escape, outside tap, or a choice.
export function MoreMenu(props: { label: string; items: MoreItem[] }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    root.current?.querySelector<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')?.focus();
    const down = (e: Event) => {
      if (root.current && !root.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', down);
    return () => document.removeEventListener('pointerdown', down);
  }, [open]);
  function onKey(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      setOpen(false);
      button.current?.focus();
      return;
    }
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    const items = [
      ...(root.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)') ??
        []),
    ];
    if (!items.length) return;
    const at = items.indexOf(document.activeElement as HTMLButtonElement);
    items[(at + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus();
    e.preventDefault();
  }
  return (
    <div class="more-menu" ref={root} onKeyDown={onKey}>
      <button
        type="button"
        ref={button}
        class="more-menu-button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={props.label}
        onClick={() => setOpen(!open)}
      >
        More
      </button>
      {open && (
        <div role="menu" aria-label={props.label} class="more-menu-list">
          {props.items.map((it) => (
            <button
              type="button"
              role="menuitem"
              class={it.danger ? 'danger' : ''}
              disabled={it.disabled}
              onClick={() => {
                setOpen(false);
                it.onSelect();
              }}
            >
              {it.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
