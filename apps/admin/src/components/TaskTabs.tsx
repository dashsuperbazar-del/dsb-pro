import { useEffect, useRef } from 'preact/hooks';

export function TaskTabs<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: readonly { value: T; label: string }[];
  onChange: (value: T) => void;
}) {
  const nav = useRef<HTMLElement>(null);
  // Edge fades say which side has more tabs; the chosen tab is scrolled into view.
  useEffect(() => {
    const el = nav.current;
    if (!el) return;
    const update = () => {
      const fits = el.scrollWidth <= el.clientWidth + 2;
      el.classList.toggle('fits', fits);
      el.classList.toggle('at-start', !fits && el.scrollLeft <= 2);
      el.classList.toggle('at-end', !fits && el.scrollLeft + el.clientWidth >= el.scrollWidth - 2);
    };
    update();
    el.addEventListener('scroll', update, { passive: true });
    window.addEventListener('resize', update);
    return () => {
      el.removeEventListener('scroll', update);
      window.removeEventListener('resize', update);
    };
  }, []);
  useEffect(() => {
    const el = nav.current;
    const pressed = el?.querySelector<HTMLElement>('[aria-pressed="true"]');
    if (!el || !pressed || el.scrollWidth <= el.clientWidth + 2) return;
    // Scroll only the strip (never the page).
    el.scrollTo?.({
      left: pressed.offsetLeft - (el.clientWidth - pressed.offsetWidth) / 2,
      behavior: 'auto',
    });
  }, [value]);
  return (
    <nav class="task-tabs" aria-label={label} ref={nav}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          aria-pressed={value === option.value}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </nav>
  );
}
