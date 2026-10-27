import type { ComponentChildren } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';

// A table that scrolls sideways when it does not fit: edge fades show which side has more, and a small
// hint says so. Display only.
export function ScrollTable(props: { children: ComponentChildren; class?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [edge, setEdge] = useState({ left: false, right: false });
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const update = () =>
      setEdge((old) => {
        const left = el.scrollLeft > 4;
        const right = el.scrollLeft + el.clientWidth < el.scrollWidth - 4;
        return old.left === left && old.right === right ? old : { left, right };
      });
    update();
    el.addEventListener('scroll', update, { passive: true });
    window.addEventListener('resize', update);
    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(update);
    ro?.observe(el);
    if (el.firstElementChild) ro?.observe(el.firstElementChild);
    return () => {
      el.removeEventListener('scroll', update);
      window.removeEventListener('resize', update);
      ro?.disconnect();
    };
  }, []);
  const more = edge.left || edge.right;
  return (
    <div
      class={`scroll-table ${edge.left ? 'fade-left' : ''} ${edge.right ? 'fade-right' : ''}`}
      data-scrollable={more ? 'true' : 'false'}
    >
      <div class={`table-wrap ${props.class ?? ''}`} ref={ref}>
        {props.children}
      </div>
      {more && (
        <p class="scroll-hint" data-testid="scroll-hint">
          {edge.right ? 'Swipe sideways to see more →' : '← Swipe back'}
        </p>
      )}
    </div>
  );
}
