import { useEffect } from 'preact/hooks';

/**
 * Help notes (every <p class="hint"> and <small class="hint">) stay out of the way: hidden by CSS, and shown as a floating card when
 * the heading above them is tapped. The heading gets a small ⓘ. A note with no heading gets its own ⓘ button.
 * Display only: the notes stay in the page for screen readers (aria-describedby) and tests.
 */
const HEADING = 'h1,h2,h3,summary,legend';

function headingFor(hint: Element): HTMLElement | null {
  for (let el = hint.previousElementSibling; el; el = el.previousElementSibling) {
    if (el.matches(HEADING)) return el as HTMLElement;
    const inner = el.matches('.row,header') ? el.querySelector(HEADING) : null;
    if (inner) return inner as HTMLElement;
  }
  const box = hint.parentElement?.closest('section,details,fieldset,form,main');
  const first = box?.querySelector(HEADING);
  return first && !hint.contains(first) ? (first as HTMLElement) : null;
}

let seq = 0;
function adopt(hint: HTMLElement) {
  if (hint.dataset.infoDone) return;
  hint.dataset.infoDone = '1';
  if (!hint.id) hint.id = `info-note-${++seq}`;
  // A field-level hint (class "field") gets its own ⓘ beside the field instead of joining a heading.
  let head = hint.classList.contains('field') ? null : headingFor(hint);
  if (!head) {
    // A span, not a button: inside a <label> a button would become the label's control.
    head = document.createElement('span');
    head.setAttribute('role', 'button');
    head.tabIndex = 0;
    head.className = 'info-dot';
    head.setAttribute('aria-label', 'About this');
    hint.before(head);
  }
  const ids = (head.dataset.info ? head.dataset.info + ' ' : '') + hint.id;
  head.dataset.info = ids;
  head.setAttribute('aria-describedby', ids);
}

function show(head: HTMLElement) {
  hide();
  const text = (head.dataset.info ?? '')
    .split(' ')
    .map((id) => document.getElementById(id)?.textContent?.trim())
    .filter(Boolean);
  if (!text.length) return;
  const card = document.createElement('div');
  card.className = 'info-float';
  card.setAttribute('role', 'note');
  for (const t of text) {
    const p = document.createElement('p');
    p.textContent = t as string;
    card.appendChild(p);
  }
  document.body.appendChild(card);
}
function hide() {
  document.querySelectorAll('.info-float').forEach((n) => n.remove());
}

export function useInfoNotes(): void {
  useEffect(() => {
    const scan = () => document.querySelectorAll<HTMLElement>('p.hint, small.hint').forEach(adopt);
    let queued = false;
    const obs = new MutationObserver(() => {
      if (queued) return;
      queued = true;
      requestAnimationFrame(() => {
        queued = false;
        scan();
      });
    });
    obs.observe(document.body, { childList: true, subtree: true });
    scan();
    const onClick = (e: MouseEvent) => {
      const open = !!document.querySelector('.info-float');
      const head = (e.target as Element | null)?.closest?.('[data-info]') as HTMLElement | null;
      // An ⓘ inside a <label> must not also focus the field (and open the keyboard).
      if (head?.classList.contains('info-dot')) e.preventDefault();
      hide();
      if (!head || open) return;
      // A <summary> also opens/closes its section: explain only when it is being opened.
      if (head.matches('summary') && (head.parentElement as HTMLDetailsElement | null)?.open)
        return;
      show(head);
    };
    document.addEventListener('click', onClick);
    return () => {
      obs.disconnect();
      document.removeEventListener('click', onClick);
      hide();
    };
  }, []);
}
