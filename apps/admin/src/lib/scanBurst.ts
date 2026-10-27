// Hardware barcode scanners (and keyboard wedges) "type" a code very fast and finish with Enter. A human never
// does: this detector recognises that burst so it can be sent to the scan path instead of the field it landed in.
// Pure and clock-injected so it can be tested with fake timers. It only decides; the caller adds nothing here.

export const SCAN_MIN_CHARS = 6;
/** The average gap between the characters of a scan must be under this... */
export const SCAN_MAX_GAP_MS = 50;
/** ...and no single gap may reach this (a busy page can stretch one gap, a person pausing cannot hide). */
export const SCAN_HARD_GAP_MS = 100;

export type BurstKey = {
  key: string;
  ctrlKey?: boolean;
  altKey?: boolean;
  metaKey?: boolean;
  repeat?: boolean;
  isComposing?: boolean;
  /** When the browser received the key (a busy page that handles keys late must not look like slow typing). */
  timeStamp?: number;
};

/**
 * Feed every keydown to `onKey`. It returns the scanned code on the Enter that ends a burst of at least
 * SCAN_MIN_CHARS printable characters typed faster than SCAN_MAX_GAP_MS apiece on average (no gap of
 * SCAN_HARD_GAP_MS or more), else null. Any other key,
 * a slow gap, a held (repeating) key, a modifier chord or a change of target field starts over.
 */
export function createBurstDetector(now: () => number = () => Date.now()) {
  let chars = '';
  let first = 0;
  let last = 0;
  let target: unknown = null;
  const reset = () => {
    chars = '';
    first = 0;
    last = 0;
    target = null;
  };
  return {
    reset,
    onKey(ev: BurstKey, field: unknown): string | null {
      if (ev.isComposing || ev.ctrlKey || ev.altKey || ev.metaKey) {
        reset();
        return null;
      }
      // Shift / Caps Lock only change the next letter (scanners and typed capitals send them): not a break.
      if (ev.key === 'Shift' || ev.key === 'CapsLock') return null;
      const t = typeof ev.timeStamp === 'number' ? ev.timeStamp : now();
      if (ev.key === 'Enter') {
        const ok =
          !ev.repeat &&
          target === field &&
          chars.length >= SCAN_MIN_CHARS &&
          t - last < SCAN_HARD_GAP_MS &&
          (last - first) / (chars.length - 1) < SCAN_MAX_GAP_MS;
        const code = ok ? chars : null;
        reset();
        return code;
      }
      if (ev.key.length !== 1 || ev.repeat) {
        reset();
        return null;
      }
      if (target !== field || t - last >= SCAN_HARD_GAP_MS) chars = '';
      if (!chars) first = t;
      target = field;
      chars += ev.key;
      last = t;
      return null;
    },
  };
}

/** A text-like field where a scan may land. Numeric quantity/price fields, checkboxes, passwords, areas: never. */
export function isScanTarget(el: unknown): el is HTMLInputElement {
  if (typeof HTMLInputElement === 'undefined' || !(el instanceof HTMLInputElement)) return false;
  const type = (el.getAttribute('type') ?? 'text').toLowerCase();
  if (type !== 'text' && type !== 'search') return false;
  const mode = (el.getAttribute('inputmode') ?? '').toLowerCase();
  return mode !== 'decimal' && mode !== 'numeric' && mode !== 'tel';
}
