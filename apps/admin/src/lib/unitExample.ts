// Pure helpers for the unit fields of the new-item form: a live example sentence, a gentle hint and the
// one-tap presets. They only describe or fill form text; saving still goes through newItemProblem /
// newItemInput (lib/newItem.ts), so unit semantics and validation are unchanged.
export type UnitText = {
  unit1?: string;
  unit2?: string;
  conv1?: string;
  unit3?: string;
  conv2?: string;
};

export type UnitExample = {
  /** e.g. "1 Kg = 1000 Gms"; '' while nothing useful can be shown yet. */
  sentence: string;
  /** A gentle next step (never an error); '' when the units read cleanly. */
  hint: string;
};

const t = (v: string | undefined) => (v ?? '').trim();
const positive = (v: string | undefined): number | undefined => {
  if (!t(v)) return undefined;
  const n = Number(t(v));
  return Number.isFinite(n) && n > 0 ? n : undefined;
};

export function unitExample(f: UnitText): UnitExample {
  const u1 = t(f.unit1);
  const u2 = t(f.unit2);
  const u3 = t(f.unit3);
  const c1 = positive(f.conv1);
  const c2 = positive(f.conv2);
  if (!u1) {
    return { sentence: '', hint: 'Type the big unit, or tap a quick setup above.' };
  }
  if (!u2) {
    if (t(f.conv1)) return { sentence: '', hint: 'Add the small unit, or clear the number.' };
    if (u3 || t(f.conv2))
      return { sentence: '', hint: 'Add the small unit before the piece unit.' };
    return { sentence: `Counted in ${u1} only.`, hint: '' };
  }
  if (c1 === undefined) {
    return { sentence: '', hint: `How many ${u2} make 1 ${u1}? Type the number.` };
  }
  const first = `1 ${u1} = ${c1} ${u2}`;
  if (!u3) {
    if (t(f.conv2)) return { sentence: first, hint: 'Add the piece unit, or clear the number.' };
    return { sentence: first, hint: '' };
  }
  if (c2 === undefined) {
    return { sentence: first, hint: `How many ${u3} make 1 ${u2}? Type the number.` };
  }
  return { sentence: `${first} · 1 ${u2} = ${c2} ${u3}`, hint: '' };
}

export type UnitPreset = { label: string; unit1: string; unit2: string; conv1: string };
/** Big unit, small unit and the usual ratio. An empty ratio means the owner types the count. */
export const UNIT_PRESETS: UnitPreset[] = [
  { label: 'Kg / Gms', unit1: 'Kg', unit2: 'Gms', conv1: '1000' },
  { label: 'Litre / ml', unit1: 'Litre', unit2: 'ml', conv1: '1000' },
  { label: 'Dozen / pcs', unit1: 'Dozen', unit2: 'pcs', conv1: '12' },
  { label: 'Packet / pcs', unit1: 'pack', unit2: 'pcs', conv1: '' },
];

/** The unit fields a preset fills; the piece unit is never touched. */
export function applyPreset(p: UnitPreset): { unit1: string; unit2: string; conv1: string } {
  return { unit1: p.unit1, unit2: p.unit2, conv1: p.conv1 };
}

/** The piece unit is set up (so its fields must stay visible or summarised, never silently dropped). */
export function hasPieceValues(f: UnitText): boolean {
  return !!(t(f.unit3) || t(f.conv2));
}
