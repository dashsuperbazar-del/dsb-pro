/**
 * Formats an integer paise amount as a ₹ rupee string, e.g. 123456 -> "₹1,234.56".
 * Money is always integer paise in the DB and packages/core; this is the only
 * place it is formatted for display (DSB_PRO_BUILD_PLAN.md §2: "escape at render only").
 */
export function toRupeeString(paise: number): string {
  if (!Number.isInteger(paise)) {
    throw new Error(`toRupeeString expects an integer paise value, got ${paise}`);
  }
  const negative = paise < 0;
  const abs = Math.abs(paise);
  const rupees = Math.floor(abs / 100);
  const remainderPaise = abs % 100;
  const rupeesFormatted = rupees.toLocaleString('en-IN');
  const sign = negative ? '-' : '';
  return `${sign}₹${rupeesFormatted}.${remainderPaise.toString().padStart(2, '0')}`;
}
