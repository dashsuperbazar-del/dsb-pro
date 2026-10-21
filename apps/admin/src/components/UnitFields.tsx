import { useEffect, useRef, useState } from 'preact/hooks';
import { ITEM_FIELD_LABELS } from '../lib/newItem';
import {
  UNIT_PRESETS,
  applyPreset,
  hasPieceValues,
  unitExample,
  type UnitPreset,
  type UnitText,
} from '../lib/unitExample';

/** Controlled use (the bill card's new-item form): the parent owns the five values. */
export type UnitFieldsControl = {
  values: UnitText;
  onField: (key: keyof UnitText, value: string) => void;
  /** aria-label = `${ariaPrefix}${aria}`, e.g. "Item 2 big unit". */
  ariaPrefix: string;
  /** Unique id of the piece-unit block. */
  pieceId: string;
  /** Id of the shared <datalist> of learned units. */
  listId: string;
  readOnly?: boolean;
  disabled?: boolean;
};

const FIELDS = [
  { key: 'unit1', aria: 'big unit' },
  { key: 'unit2', aria: 'small unit' },
  { key: 'conv1', aria: 'small units per big', number: true },
  { key: 'unit3', aria: 'piece unit' },
  { key: 'conv2', aria: 'pieces per small', number: true },
] as const;

// The five unit inputs of the new-item forms (big → small → piece), shared by the Inventory "Add item" form
// and the bill card's "+ Create" form. Uncontrolled (default): plain named inputs inside the parent <form>,
// so its own submit reads them as before; this component only mirrors their text to show a live example,
// fills them from a preset, and folds the rarely used piece unit away. Controlled: the same, over values
// the parent holds. Folding never clears anything: a collapsed piece unit that has values stays in the
// form, is summarised, and is saved.
export function UnitFields({
  suggestions,
  initial,
  controlled,
}: {
  suggestions?: string[];
  initial?: UnitText;
  controlled?: UnitFieldsControl;
}) {
  const root = useRef<HTMLDivElement>(null);
  const [mirror, setMirror] = useState<UnitText>(initial ?? controlled?.values ?? {});
  const vals = controlled ? controlled.values : mirror;
  const [pieceOpen, setPieceOpen] = useState(() => hasPieceValues(vals));
  const pieceId = controlled?.pieceId ?? 'unit-piece-fields';
  const listId = controlled?.listId ?? 'learned-units';

  const read = (): UnitText => {
    const get = (name: string) =>
      root.current?.querySelector<HTMLInputElement>(`input[name="${name}"]`)?.value ?? '';
    return {
      unit1: get('unit1'),
      unit2: get('unit2'),
      conv1: get('conv1'),
      unit3: get('unit3'),
      conv2: get('conv2'),
    };
  };
  const sync = () => {
    if (controlled) return;
    const v = read();
    setMirror(v);
    if (hasPieceValues(v)) setPieceOpen(true);
  };

  // The parent resets the form after a save; fold the form state back with it.
  useEffect(() => {
    if (controlled) return;
    const form = root.current?.closest('form');
    if (!form) return;
    const onReset = () => {
      setTimeout(() => {
        setMirror(read());
        setPieceOpen(false);
      }, 0);
    };
    form.addEventListener('reset', onReset);
    return () => form.removeEventListener('reset', onReset);
  }, []);

  function usePreset(p: UnitPreset) {
    const fill = applyPreset(p);
    if (controlled) {
      for (const [key, value] of Object.entries(fill))
        controlled.onField(key as keyof UnitText, value);
    } else {
      for (const [name, value] of Object.entries(fill)) {
        const input = root.current?.querySelector<HTMLInputElement>(`input[name="${name}"]`);
        if (input) input.value = value;
      }
      sync();
    }
    // "Packet": the owner still has to enter the count.
    if (!fill.conv1)
      setTimeout(
        () =>
          root.current
            ?.querySelector<HTMLInputElement>('input[name="conv1"], [data-field="conv1"]')
            ?.focus(),
        0,
      );
  }

  const ex = unitExample(vals);
  const pieceSummary = hasPieceValues(vals)
    ? `${(vals.unit3 ?? '').trim() || '?'}${(vals.conv2 ?? '').trim() ? `, ${(vals.conv2 ?? '').trim()} per ${(vals.unit2 ?? '').trim() || 'small unit'}` : ''}`
    : '';

  const field = (f: (typeof FIELDS)[number]) => {
    const label = ITEM_FIELD_LABELS[f.key];
    const num = 'number' in f;
    return (
      <label>
        {label}{' '}
        <input
          name={f.key}
          data-field={f.key}
          placeholder={label}
          list={num ? undefined : listId}
          required={f.key === 'unit1'}
          {...(num ? { type: 'number', inputMode: 'decimal', min: '0', step: 'any' } : {})}
          {...(controlled
            ? {
                'aria-label': `${controlled.ariaPrefix}${f.aria}`,
                autocomplete: 'off',
                value: controlled.values[f.key] ?? '',
                readOnly: controlled.readOnly,
                disabled: controlled.disabled,
                onInput: (e: Event) => {
                  const value = (e.currentTarget as HTMLInputElement).value;
                  controlled.onField(f.key, value);
                  if ((f.key === 'unit3' || f.key === 'conv2') && value.trim()) setPieceOpen(true);
                },
              }
            : {})}
        />
      </label>
    );
  };

  return (
    <div class="unit-fields" ref={root} onInput={sync}>
      <div class="unit-presets" role="group" aria-label="Quick unit setups">
        <span class="muted">Quick setup:</span>
        {UNIT_PRESETS.map((p) => (
          <button
            type="button"
            class="chip"
            key={p.label}
            aria-label={`Use ${p.label} units`}
            disabled={controlled?.readOnly || controlled?.disabled}
            onClick={() => usePreset(p)}
          >
            {p.label}
          </button>
        ))}
      </div>
      <div class="unit-grid">
        {field(FIELDS[0])}
        {field(FIELDS[1])}
        {field(FIELDS[2])}
      </div>
      <p class="muted unit-help">
        Only the big unit is needed. Leave the small unit and number blank for loose or single-unit
        items.
      </p>
      <div class="unit-piece">
        <button
          type="button"
          class="link-button"
          aria-expanded={pieceOpen}
          aria-controls={pieceId}
          onClick={() => setPieceOpen((o) => !o)}
        >
          {pieceOpen ? 'Hide piece unit' : 'Add a piece unit'}
        </button>
        {!pieceOpen && pieceSummary && (
          <span class="muted" data-testid="piece-summary">
            {' '}
            Piece unit kept: {pieceSummary}
          </span>
        )}
        <div id={pieceId} class="unit-grid" hidden={!pieceOpen}>
          {field(FIELDS[3])}
          {field(FIELDS[4])}
        </div>
        {!controlled && (
          <datalist id={listId}>
            {(suggestions ?? []).map((u) => (
              <option key={u} value={u} />
            ))}
          </datalist>
        )}
      </div>
      <p class="unit-example" role="status" aria-label="Unit example" data-testid="unit-example">
        {ex.sentence && (
          <>
            <strong>Example:</strong> {ex.sentence}
          </>
        )}
        {ex.hint && (
          <span class="muted">
            {ex.sentence ? ' ' : ''}
            {ex.hint}
          </span>
        )}
      </p>
    </div>
  );
}
