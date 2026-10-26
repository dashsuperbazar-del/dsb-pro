import type { ComponentChildren } from 'preact';
import { useEffect, useState } from 'preact/hooks';

// Home (D1): a compact one-line row — title, count badge, short summary — that expands to the full tile.
// Collapsed by default; the open/closed choice is remembered per user on this device (a convenience only).
const key = (userId: string | undefined, name: string) =>
  `dsb-pro:home-open:${userId ?? 'anon'}:${name}`;
function readOpen(userId: string | undefined, name: string): boolean {
  try {
    return localStorage.getItem(key(userId, name)) === '1';
  } catch {
    return false;
  }
}
export type RowTone = 'danger' | 'warning' | 'neutral';
export function HomeRow(props: {
  name: string;
  title: string;
  userId?: string;
  count: number | null;
  tone: RowTone;
  summary: string;
  class?: string;
  /** Accessible name of the section when it differs from the visible title. */
  label?: string;
  /** Safety exception: stays open while true (e.g. a refused item needs attention). */
  forceOpen?: boolean;
  children: ComponentChildren;
}) {
  const [stored, setOpen] = useState(() => readOpen(props.userId, props.name));
  // The user may become known after the first render: read their choice then.
  useEffect(() => setOpen(readOpen(props.userId, props.name)), [props.userId, props.name]);
  const open = stored || Boolean(props.forceOpen);
  const bodyId = `home-row-${props.name}`;
  return (
    <section class={`home-row ${props.class ?? ''}`} aria-label={props.label ?? props.title}>
      <h2>
        <button
          type="button"
          class="home-row-toggle"
          aria-expanded={open}
          aria-controls={bodyId}
          onClick={() => {
            const next = !stored;
            setOpen(next);
            try {
              localStorage.setItem(key(props.userId, props.name), next ? '1' : '0');
            } catch {
              /* remembered for this visit only */
            }
          }}
        >
          <span class="home-row-title">{props.title}</span>
          {props.count !== null && (
            <span class={`badge ${props.tone === 'neutral' ? '' : props.tone}`}>{props.count}</span>
          )}
          <span class="home-row-summary">{props.summary}</span>
        </button>
      </h2>
      <div id={bodyId} class="home-row-body" hidden={!open}>
        {props.children}
      </div>
    </section>
  );
}
