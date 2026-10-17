import type { Item } from '@dsb-pro/adapters';

// C06 voice entry (old DSB parseVoiceEntry): "<item name> <qty> [unit] [rate]", e.g. "choco pie 5 carton 2550".
// It only FILLS the purchase line form; the user still checks it and presses Add line. An item is picked only
// when exactly one item's name matches; otherwise the words go into the search box.
export type VoiceEntry = {
  name: string;
  qty: string | null;
  unitWord: string | null;
  rate: string | null;
};

const NUMBER = /^\d+(\.\d+)?$/;

export function parseVoiceEntry(text: string): VoiceEntry | null {
  const tokens = text.toLowerCase().trim().split(/\s+/).filter(Boolean);
  const nums = tokens.map((t, i) => (NUMBER.test(t) ? i : -1)).filter((i) => i >= 0);
  const first = nums.length ? nums[0]! : tokens.length;
  const name = tokens.slice(0, first).join(' ').trim();
  if (!name) return null;
  if (!nums.length) return { name, qty: null, unitWord: null, rate: null };
  const qty = tokens[first]!;
  const after = tokens[first + 1];
  const unitWord = after && !NUMBER.test(after) ? after : null;
  const rate = nums.length >= 2 ? tokens[nums[nums.length - 1]!]! : null;
  return { name, qty, unitWord, rate };
}

export function matchItems(items: Item[], name: string): Item[] {
  const q = name.toLowerCase().trim();
  if (!q) return [];
  const exact = items.filter((i) => i.name.toLowerCase().trim() === q);
  if (exact.length) return exact;
  return items.filter((i) => i.name.toLowerCase().includes(q));
}

export function unitLevelFor(item: Item, word: string | null): 1 | 2 | 3 | null {
  if (!word) return null;
  const w = word.toLowerCase();
  const same = (u: string | null | undefined) => {
    const v = (u ?? '').toLowerCase().trim();
    return !!v && (v === w || v + 's' === w || v === w + 's');
  };
  if (same(item.unit1)) return 1;
  if (same(item.unit2)) return 2;
  if (same(item.unit3)) return 3;
  return null;
}

type Recognition = {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult: ((e: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null;
  onerror: ((e: { error?: string }) => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
};
export function speechRecognitionCtor(): (new () => Recognition) | null {
  const g = globalThis as unknown as {
    SpeechRecognition?: new () => Recognition;
    webkitSpeechRecognition?: new () => Recognition;
  };
  return g.SpeechRecognition ?? g.webkitSpeechRecognition ?? null;
}
