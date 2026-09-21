const QUANTITY_SCALE = 1_000_000n;
const MAX_SAFE_INTEGER = BigInt(Number.MAX_SAFE_INTEGER);

export type DecimalInput = string | number;

function decimalText(value: DecimalInput, name: string): string {
  const text = typeof value === 'number' ? String(value) : value.trim();
  if (!text || /[eE]/.test(text) || !/^\d+(?:\.\d+)?$/.test(text)) {
    throw new Error(`${name} must be a plain non-negative decimal`);
  }
  return text;
}

function parseScaledDecimal(value: DecimalInput, scaleDigits: number, name: string): bigint {
  const text = decimalText(value, name);
  const [whole, fraction = ''] = text.split('.');
  if (fraction.length > scaleDigits) throw new Error(`${name} supports at most ${scaleDigits} decimal places`);
  return BigInt(whole) * (10n ** BigInt(scaleDigits)) + BigInt(fraction.padEnd(scaleDigits, '0') || '0');
}

function safeInteger(value: bigint, name: string): number {
  if (value > MAX_SAFE_INTEGER) throw new Error(`${name} exceeds the safe integer range`);
  return Number(value);
}

/** Rounds a non-negative rational number to its nearest integer; exact halves go upward. */
export function divideHalfUp(numerator: bigint, denominator: bigint): bigint {
  if (numerator < 0n || denominator <= 0n) throw new Error('divideHalfUp requires a non-negative numerator and positive denominator');
  const quotient = numerator / denominator;
  const remainder = numerator % denominator;
  return quotient + (remainder * 2n >= denominator ? 1n : 0n);
}

/** Parses a quantity into millionths without ever passing through binary floating point. */
export function parseQuantityMicros(value: DecimalInput): bigint {
  const micros = parseScaledDecimal(value, 6, 'quantity');
  if (micros <= 0n) throw new Error('qty must be greater than zero');
  return micros;
}

export function parseNonNegativeDecimalMicros(value: DecimalInput, name: string): bigint {
  return parseScaledDecimal(value, 6, name);
}

export function canonicalQuantity(value: DecimalInput): string {
  const micros = parseQuantityMicros(value);
  const whole = micros / QUANTITY_SCALE;
  const fraction = String(micros % QUANTITY_SCALE).padStart(6, '0').replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : String(whole);
}

export function quantityTimesPaise(value: DecimalInput, unitPricePaise: number): number {
  if (!Number.isSafeInteger(unitPricePaise) || unitPricePaise < 0) {
    throw new Error('unitPricePaise must be a non-negative integer paise value');
  }
  return safeInteger(divideHalfUp(parseQuantityMicros(value) * BigInt(unitPricePaise), QUANTITY_SCALE), 'line total');
}

/** Parses rupee text directly to paise, rounding a sub-paisa half upward. */
export function parseRupeesToPaise(value: DecimalInput): number {
  const millionthsOfRupee = parseScaledDecimal(value, 6, 'rupee amount');
  return safeInteger(divideHalfUp(millionthsOfRupee, 10_000n), 'rupee amount');
}

type Rational = Readonly<{ numerator: bigint; denominator: bigint }>;

function decimalRational(value: DecimalInput, name: string): Rational {
  const text = decimalText(value, name);
  const [whole, fraction = ''] = text.split('.');
  if (fraction.length > 6) throw new Error(`${name} supports at most 6 decimal places`);
  const denominator = 10n ** BigInt(fraction.length);
  const numerator = BigInt(whole) * denominator + BigInt(fraction || '0');
  if (numerator <= 0n) throw new Error(`${name} must be greater than zero`);
  return { numerator, denominator };
}

export function multiplyPaiseByRatio(
  paise: number,
  numeratorFactors: DecimalInput[],
  denominatorFactors: DecimalInput[],
): number {
  if (!Number.isSafeInteger(paise) || paise < 0) throw new Error('paise must be a non-negative integer');
  let numerator = BigInt(paise);
  let denominator = 1n;
  for (const factor of numeratorFactors) {
    const ratio = decimalRational(factor, 'conversion factor');
    numerator *= ratio.numerator;
    denominator *= ratio.denominator;
  }
  for (const factor of denominatorFactors) {
    const ratio = decimalRational(factor, 'conversion factor');
    numerator *= ratio.denominator;
    denominator *= ratio.numerator;
  }
  return safeInteger(divideHalfUp(numerator, denominator), 'converted price');
}
