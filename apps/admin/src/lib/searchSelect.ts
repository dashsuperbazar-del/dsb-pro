import { useEffect } from 'preact/hooks';

/**
 * Old-DSB pickers: every list dropdown of parties, customers or items ("Choose…", "Select…", "No supplier", or
 * more than 8 options) gets a type-to-search box with name suggestions. The real <select> stays in the page
 * (visually hidden, still labelled) and keeps the value: picking a suggestion sets it and fires the same
 * "change" event the screen already handles, so no screen logic changes.
 */
const PLACEHOLDER = /^(choose|select|pick|no supplier|no customer|all )/i;
const MAX = 40;

function wanted(sel: HTMLSelectElement): boolean {
  if (sel.multiple || sel.dataset.noSearch !== undefined) return false;
  const first = sel.options[0]?.text.trim() ?? '';
  return sel.options.length > 8 || (PLACEHOLDER.test(first) && sel.options.length > 2);
}

function textOf(sel: HTMLSelectElement): string {
  const o = sel.options[sel.selectedIndex];
  return o && o.value !== '' ? o.text.trim() : '';
}

function enhance(sel: HTMLSelectElement) {
  if (sel.dataset.ss) return;
  sel.dataset.ss = '1';
  const wrap = document.createElement('span');
  wrap.className = 'ss-wrap';
  const input = document.createElement('input');
  input.type = 'search';
  input.className = 'ss-input';
  input.autocomplete = 'off';
  input.setAttribute('role', 'combobox');
  input.setAttribute('aria-autocomplete', 'list');
  input.setAttribute('aria-expanded', 'false');
  const label = sel.labels?.[0]?.textContent?.trim() || sel.getAttribute('aria-label') || 'item';
  input.setAttribute('aria-label', 'Type to search the list');
  input.title = label;
  const first = sel.options[0];
  input.placeholder =
    first && first.value === '' && !PLACEHOLDER.test(first.text.trim())
      ? first.text.trim()
      : 'Type to search…';
  const list = document.createElement('ul');
  list.className = 'ss-list';
  list.setAttribute('role', 'listbox');
  list.hidden = true;
  sel.classList.add('ss-native');
  sel.tabIndex = -1;
  // After the select: a <label> names its FIRST control, which must stay the real select.
  sel.after(wrap);
  wrap.append(input, list);

  let active = -1;
  const sync = () => {
    input.disabled = sel.disabled;
    if (document.activeElement !== input) input.value = textOf(sel);
  };
  const close = () => {
    list.hidden = true;
    input.setAttribute('aria-expanded', 'false');
    active = -1;
  };
  const pick = (value: string) => {
    sel.value = value;
    sel.dispatchEvent(new Event('input', { bubbles: true }));
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    input.value = textOf(sel);
    close();
  };
  const render = () => {
    const q = input.value.trim().toLowerCase();
    const opts = Array.from(sel.options).filter((o) => !o.disabled && o.text.trim());
    const hits = opts
      .filter((o) => !q || o.text.toLowerCase().includes(q))
      .sort((a, b) => {
        if (!q) return 0;
        const sa = a.text.toLowerCase().startsWith(q) ? 0 : 1;
        const sb = b.text.toLowerCase().startsWith(q) ? 0 : 1;
        return sa - sb;
      })
      .slice(0, MAX);
    list.replaceChildren(
      ...hits.map((o, i) => {
        const li = document.createElement('li');
        li.setAttribute('role', 'option');
        li.textContent = o.text.trim();
        if (o.value === sel.value) li.setAttribute('aria-selected', 'true');
        if (i === active) li.classList.add('active');
        li.addEventListener('mousedown', (e) => {
          e.preventDefault();
          pick(o.value);
        });
        return li;
      }),
    );
    if (!hits.length) {
      const li = document.createElement('li');
      li.className = 'ss-empty';
      li.textContent = 'No match';
      list.append(li);
    }
    list.hidden = false;
    input.setAttribute('aria-expanded', 'true');
  };
  input.addEventListener('focus', () => {
    input.select();
    render();
  });
  input.addEventListener('input', () => {
    active = -1;
    render();
  });
  input.addEventListener('keydown', (e) => {
    const items = Array.from(list.querySelectorAll<HTMLLIElement>('li[role="option"]'));
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (list.hidden) render();
      active = Math.max(0, Math.min(items.length - 1, active + (e.key === 'ArrowDown' ? 1 : -1)));
      items.forEach((li, i) => li.classList.toggle('active', i === active));
      items[active]?.scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'Enter' && !list.hidden) {
      const choice = items[active >= 0 ? active : 0];
      if (choice) {
        e.preventDefault();
        choice.dispatchEvent(new MouseEvent('mousedown'));
      }
    } else if (e.key === 'Escape') {
      close();
      input.value = textOf(sel);
    }
  });
  input.addEventListener('blur', () => {
    close();
    // Typing alone never changes the value: an empty box clears it only when the list allows "none".
    if (!input.value.trim() && sel.options[0]?.value === '' && sel.value !== '') pick('');
    input.value = textOf(sel);
  });
  sel.addEventListener('change', sync);
  sync();
  (sel as HTMLSelectElement & { _ssSync?: () => void })._ssSync = sync;
}

export function useSearchSelects(): void {
  useEffect(() => {
    const scan = () => {
      document.querySelectorAll<HTMLSelectElement>('select').forEach((s) => {
        if (s.dataset.ss) (s as HTMLSelectElement & { _ssSync?: () => void })._ssSync?.();
        else if (wanted(s)) enhance(s);
      });
    };
    let queued = false;
    const obs = new MutationObserver(() => {
      if (queued) return;
      queued = true;
      requestAnimationFrame(() => {
        queued = false;
        scan();
      });
    });
    obs.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['disabled'],
    });
    // Screens also set a select's value directly (drafts, deep links): keep the box text in step.
    const tick = window.setInterval(scan, 400);
    scan();
    return () => {
      obs.disconnect();
      window.clearInterval(tick);
    };
  }, []);
}
