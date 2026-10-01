// Integer-text paise → "₹1,23,456.78" by string grouping (Indian style), never through Number,
// so report totals beyond Number.MAX_SAFE_INTEGER stay exact.
export function rupees(paise: string | number): string {
  const s = typeof paise === 'number' ? BigInt(Math.trunc(paise)).toString() : String(paise).trim();
  const neg = s.startsWith('-');
  const digits = (neg ? s.slice(1) : s).padStart(3, '0');
  const whole = digits.slice(0, -2).replace(/^0+(?=\d)/, '');
  const last3 = whole.slice(-3);
  const rest = whole.slice(0, -3);
  const grouped = rest ? `${rest.replace(/\B(?=(\d{2})+(?!\d))/g, ',')},${last3}` : last3;
  return `${neg ? '−' : ''}₹${grouped}.${digits.slice(-2)}`;
}

// Integer-text paise → plain "1234.56" for CSV (no symbol, no grouping, exact).
export function paiseToDecimal(paise: string | number): string {
  const s = typeof paise === 'number' ? BigInt(Math.trunc(paise)).toString() : String(paise).trim();
  const neg = s.startsWith('-');
  const digits = (neg ? s.slice(1) : s).padStart(3, '0');
  const whole = digits.slice(0, -2).replace(/^0+(?=\d)/, '');
  return `${neg ? '-' : ''}${whole}.${digits.slice(-2)}`;
}
