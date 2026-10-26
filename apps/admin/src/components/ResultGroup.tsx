import type { ComponentChildren } from 'preact';

// D3: a collapsible group of tappable result rows, the Home row look (title + count badge + chevron) with
// a flush list inside. Used by Search; the rows are plain links, so the whole row is the tap target.
export type ChipTone = 'success' | 'warning' | 'danger' | 'info' | '';
export type ResultRowData = {
  id: string;
  href: string;
  title: string;
  /** Second line (muted): SKU, phone, bill code · party · date. */
  secondary?: string[];
  /** Right-aligned figure (tabular), e.g. stock or an amount; `valueSub` is the small line under it. */
  value?: string;
  valueSub?: string;
  chip?: { label: string; tone: ChipTone };
};

export function ResultRow({
  row,
  prefix,
  onOpen,
}: {
  row: ResultRowData;
  prefix: string;
  onOpen?: () => void;
}) {
  const titleId = `${prefix}-t-${row.id}`;
  const descId = `${prefix}-d-${row.id}`;
  return (
    <li>
      {/* The link's name is the title alone (as before); the rest is its description. */}
      <a
        class="result-row"
        href={row.href}
        aria-labelledby={titleId}
        aria-describedby={descId}
        onClick={onOpen}
      >
        <span class="result-main">
          <strong id={titleId} class="result-title">
            {row.title}
          </strong>
          {row.secondary && row.secondary.length > 0 && (
            <small class="result-sub">
              {row.secondary.map((part, i) => (
                <span key={i} class="result-part">
                  {i > 0 ? ' · ' : ''}
                  <span class={part.length <= 24 ? 'nowrap' : undefined}>{part}</span>
                </span>
              ))}
            </small>
          )}
        </span>
        <span class="result-side" id={descId}>
          {row.value && <span class="result-value money">{row.value}</span>}
          {row.valueSub && <small class="result-sub">{row.valueSub}</small>}
          {row.chip && <span class={`chip ${row.chip.tone}`}>{row.chip.label}</span>}
        </span>
        <span class="result-chevron" aria-hidden="true" />
      </a>
    </li>
  );
}

export function ResultGroup(props: {
  title: string;
  total: number;
  open: boolean;
  onToggle: () => void;
  rows: ResultRowData[];
  onMore?: () => void;
  moreCount?: number;
  onOpen?: () => void;
  children?: ComponentChildren;
}) {
  const bodyId = `result-group-${props.title.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
  return (
    <section class="home-row result-group" aria-label={props.title}>
      <h2>
        <button
          type="button"
          class="home-row-toggle"
          aria-expanded={props.open}
          aria-controls={bodyId}
          onClick={props.onToggle}
        >
          <span class="home-row-title">{props.title}</span>
          <span class="badge">{props.total}</span>
        </button>
      </h2>
      <div id={bodyId} class="home-row-body result-body" hidden={!props.open}>
        <ul class="result-list">
          {props.rows.map((row) => (
            <ResultRow key={row.id} row={row} prefix={bodyId} onOpen={props.onOpen} />
          ))}
        </ul>
        {props.onMore && props.moreCount ? (
          <button type="button" class="result-more" onClick={props.onMore}>
            Show {Math.min(20, props.moreCount)} more
            {props.moreCount > 20 ? ` (${props.moreCount} left)` : ''}
          </button>
        ) : null}
        {props.children}
      </div>
    </section>
  );
}
