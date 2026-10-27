// One place that turns what the server or the device threw into a sentence a cashier can act on.
// The code (DSB_…) is kept apart so the screen can show it in small text for support. Display only:
// nothing here changes what is sent or how a refusal is decided.
export type FriendlyError = { text: string; code: string | null };

const BY_CODE: Record<string, string> = {
  DSB_TOTAL_MISMATCH:
    'The bill total changed after you built it (a price or tax was updated). Check the bill and finalize again.',
  DSB_CREDIT_LIMIT_EXCEEDED:
    "This credit sale is over the customer's credit limit. Take more payment, or ask the owner or a manager.",
  DSB_CREDIT_LIMIT_NOT_PERMITTED: 'Only an owner or manager can set a credit limit.',
  DSB_CREDIT_OVERRIDE_NOT_PERMITTED:
    'Only an owner or manager can allow a sale over the credit limit. Ask them, or take more payment.',
  DSB_PRICE_OVERRIDE_NOT_PERMITTED:
    'Only an owner or manager can type a price. Use the list price, or ask them.',
  DSB_GST_EXTRA_BILL_DISCOUNT:
    'A bill discount is not allowed when GST is added on top. Use item discounts instead.',
  DSB_FREE_TEXT_INVALID:
    'The item that is not in the list needs a name, a quantity and a price above zero.',
  DSB_PAYLOAD_MISMATCH:
    'An earlier version of this sale was already received. Check Sales history before entering it again.',
  DSB_FUTURE_DATE: "The date is in the future. Use today's date.",
  DSB_ITEM_REJECTED:
    'An item on this bill could not be saved. Correct the bill, or ask the owner or a manager.',
};

// Server sentences (no code) that deserve one more line telling the cashier what to do next.
const BY_SENTENCE: [RegExp, string][] = [
  [
    /walk-in sale must be fully paid/i,
    'Walk-in sale must be fully paid. Enter the full amount, or choose a customer to keep the rest on credit.',
  ],
  [
    /payments exceed sale total/i,
    'Payments exceed sale total. Lower the amount to the bill total or less.',
  ],
  [
    /insufficient stock/i,
    'Not enough stock for this sale. Reduce the quantity, or ask the owner or a manager.',
  ],
];

const CODE = /\bDSB_[A-Z0-9_]+\b/;

// Anything that is not a string or an Error (a PostgREST error object, a bare {}) must never print as
// "[object Object]": take its details/hint/error text, else say so plainly.
function readable(raw: unknown): string {
  if (raw && typeof raw === 'object') {
    const o = raw as Record<string, unknown>;
    for (const key of ['details', 'hint', 'error_description', 'error', 'code'])
      if (typeof o[key] === 'string' && (o[key] as string).trim()) return o[key] as string;
    return '';
  }
  return raw === null || raw === undefined ? '' : String(raw);
}

/** Just the sentence, for places that keep one string (never "[object Object]", never a raw DSB_ code). */
export function errorText(raw: unknown): string {
  const f = friendlyError(raw);
  return f.text.startsWith('Something went wrong. Check Sales history')
    ? 'Something went wrong. Please try again.'
    : f.text;
}

export function friendlyError(raw: unknown): FriendlyError {
  const message =
    raw instanceof Error
      ? raw.message
      : typeof raw === 'string'
        ? raw
        : raw && typeof (raw as { message?: unknown }).message === 'string'
          ? (raw as { message: string }).message
          : readable(raw);
  const cleaned = message.replace(/^(?:Error: )+/, '').trim();
  const code = cleaned.match(CODE)?.[0] ?? null;
  if (code && BY_CODE[code]) return { text: BY_CODE[code], code };
  // An unlisted code keeps the server's own sentence, without the code in front of it.
  const text = code ? cleaned.replace(new RegExp(`${code}:?\\s*`), '').trim() : cleaned;
  for (const [pattern, sentence] of BY_SENTENCE)
    if (pattern.test(text)) return { text: sentence, code };
  return { text: text || 'Something went wrong. Check Sales history before trying again.', code };
}
