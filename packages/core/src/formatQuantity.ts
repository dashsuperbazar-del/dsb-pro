/**
 * Display-only quantity text: numeric(18,6) values arrive as "5.000000"; shoppers read "5", "2.5", "0.125".
 * Never use the result for storage, sending or arithmetic — those keep the exact stored value.
 */
export function formatQuantity(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return '';
  let text =
    typeof value === 'number'
      ? Number.isFinite(value)
        ? value.toFixed(6)
        : String(value)
      : value.trim();
  const m = /^(-?)(\d+)(?:\.(\d+))?$/.exec(text);
  if (!m) return text;
  const whole = m[2]!.replace(/^0+(?=\d)/, '');
  const fraction = (m[3] ?? '').replace(/0+$/, '');
  text = fraction ? `${whole}.${fraction}` : whole;
  return m[1] && text !== '0' ? `-${text}` : text;
}
