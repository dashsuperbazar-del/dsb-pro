import type { ComponentChildren } from 'preact';
import { useEffect } from 'preact/hooks';

/** Old-DSB layout kit (L1): slide-up sheet, stat tiles, document cards, underline tabs, section titles. */

export function Sheet({
  open,
  title,
  onClose,
  children,
}: {
  open: boolean;
  title: string;
  onClose: () => void;
  children: ComponentChildren;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div class="kit-overlay" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <section class="kit-sheet" role="dialog" aria-modal="true" aria-label={title}>
        <div class="kit-handle" aria-hidden="true" />
        <button type="button" class="kit-close" aria-label="Close" onClick={onClose}>
          ×
        </button>
        <h2 class="kit-sheet-title">{title}</h2>
        {children}
      </section>
    </div>
  );
}

export function StatGrid({ children }: { children: ComponentChildren }) {
  return <div class="kit-stats">{children}</div>;
}

export function StatTile({
  label,
  value,
  tone,
  testId,
}: {
  label: string;
  value: ComponentChildren;
  tone?: 'danger' | 'success' | 'brand';
  testId?: string;
}) {
  return (
    <div class="kit-stat" data-testid={testId}>
      <div class="kit-stat-label">{label}</div>
      <div class={`kit-stat-value num${tone ? ` ${tone}` : ''}`}>{value}</div>
    </div>
  );
}

export type DocStatus = 'credit' | 'partial' | 'paid' | 'cash' | 'pending' | 'void';
const STATUS_TEXT: Record<DocStatus, string> = {
  credit: 'Credit',
  partial: 'Partial',
  paid: 'Paid',
  cash: 'Cash',
  pending: 'Items pending',
  void: 'Void',
};

export function DocCard({
  party,
  docNo,
  date,
  amount,
  status,
  extra,
  onOpen,
}: {
  party: string;
  docNo: string;
  date: string;
  amount: string;
  status?: DocStatus;
  extra?: ComponentChildren;
  onOpen?: () => void;
}) {
  return (
    <button type="button" class={`kit-doc${status ? ` is-${status}` : ''}`} onClick={onOpen}>
      <span class="kit-doc-main">
        <span class="kit-doc-party">{party}</span>
        <span class="kit-doc-meta">
          {docNo} · {date}
        </span>
        {extra && <span class="kit-doc-extra">{extra}</span>}
      </span>
      <span class="kit-doc-side">
        <span class="kit-doc-amount num">{amount}</span>
        {status && <span class={`kit-badge ${status}`}>{STATUS_TEXT[status]}</span>}
      </span>
    </button>
  );
}

export function Tabs<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
}) {
  return (
    <div class="kit-tabs" role="tablist" aria-label={label}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="tab"
          aria-selected={o.value === value}
          class={`kit-tab${o.value === value ? ' active' : ''}`}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function SectionTitle({ children }: { children: ComponentChildren }) {
  return <h3 class="kit-section">{children}</h3>;
}
