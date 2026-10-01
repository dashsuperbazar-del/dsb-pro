// Integer-text paise → "₹1,234.56" without floating point.
export function rupees(paise: string | number): string {
  const s = String(paise);
  const neg = s.startsWith('-');
  const digits = (neg ? s.slice(1) : s).padStart(3, '0');
  const whole = digits.slice(0, -2).replace(/^0+(?=\d)/, '');
  return `${neg ? '−' : ''}₹${Number(whole).toLocaleString('en-IN')}.${digits.slice(-2)}`;
}
