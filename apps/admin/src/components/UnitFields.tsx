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

// The five unit inputs of the new-item form (big → small → piece). The inputs are plain named, uncontrolled
// fields inside the parent <form>, so the form's own submit reads them exactly as before; this component
// only mirrors their text to show a live example, fills them from a preset, and folds the rarely used
// piece unit away. Folding never clears anything: a collapsed piece unit that has values stays in the
// form, is summarised, and is saved.
export function UnitFields({
  suggestions,
  initial,
}: {
  suggestions: string[];
  initial?: UnitText;
}) {
  const root = useRef<HTMLDivElement>(null);
  const [vals, setVals] = useState<UnitText>(initial ?? {});
  const [pieceOpen, setPieceOpen] = useState(() => hasPieceValues(initial ?? {}));

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
    const v = read();
    setVals(v);
    if (hasPieceValues(v)) setPieceOpen(true);
  };

  // The parent resets the form after a save; fold the form state back with it.
  useEffect(() => {
    const form = root.current?.closest('form');
    if (!form) return;
    const onReset = () => {
      setTimeout(() => {
        setVals(read());
        setPieceOpen(false);
      }, 0);
    };
    form.addEventListener('reset', onReset);
    return () => form.removeEventListener('reset', onReset);
  }, []);

  function usePreset(p: UnitPreset) {
    const fill = applyPreset(p);
    for (const [name, value] of Object.entries(fill)) {
      const input = root.current?.querySelector<HTMLInputElement>(`input[name="${name}"]`);
      if (input) input.value = value;
    }
    sync();
    // "Packet": the owner still has to enter the count.
    if (!fill.conv1) root.current?.querySelector<HTMLInputElement>('input[name="conv1"]')?.focus();
  }

  const ex = unitExample(vals);
  const pieceSummary = hasPieceValues(vals)
    ? `${(vals.unit3 ?? '').trim() || '?'}${(vals.conv2 ?? '').trim() ? `, ${(vals.conv2 ?? '').trim()} per ${(vals.unit2 ?? '').trim() || 'small unit'}` : ''}`
    : '';

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
            onClick={() => usePreset(p)}
          >
            {p.label}
          </button>
        ))}
      </div>
      <div class="unit-grid">
        <label>
          {ITEM_FIELD_LABELS.unit1}{' '}
          <input name="unit1" placeholder={ITEM_FIELD_LABELS.unit1} required list="learned-units" />
        </label>
        <label>
          {ITEM_FIELD_LABELS.unit2}{' '}
          <input name="unit2" placeholder={ITEM_FIELD_LABELS.unit2} list="learned-units" />
        </label>
        <label>
          {ITEM_FIELD_LABELS.conv1}{' '}
          <input
            name="conv1"
            type="number"
            inputMode="decimal"
            min="0"
            step="any"
            placeholder={ITEM_FIELD_LABELS.conv1}
          />
        </label>
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
          aria-controls="unit-piece-fields"
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
        <div id="unit-piece-fields" class="unit-grid" hidden={!pieceOpen}>
          <label>
            {ITEM_FIELD_LABELS.unit3}{' '}
            <input name="unit3" placeholder={ITEM_FIELD_LABELS.unit3} list="learned-units" />
            <datalist id="learned-units">
              {suggestions.map((u) => (
                <option key={u} value={u} />
              ))}
            </datalist>
          </label>
          <label>
            {ITEM_FIELD_LABELS.conv2}{' '}
            <input
              name="conv2"
              type="number"
              inputMode="decimal"
              min="0"
              step="any"
              placeholder={ITEM_FIELD_LABELS.conv2}
            />
          </label>
        </div>
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
