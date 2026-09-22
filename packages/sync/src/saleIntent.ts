import { canonicalQuantity } from '@dsb-pro/core';
import type { OfflineSalePayload } from './types';

function stable(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  const row = value as Record<string, unknown>;
  return `{${Object.keys(row).sort().map(key => `${JSON.stringify(key)}:${stable(row[key])}`).join(',')}}`;
}

/**
 * A deterministic intent checksum used to bind an acknowledgement to the
 * exact queued payload. It is not an authorization primitive; the server
 * still re-resolves permissions, prices, stock, and idempotency.
 */
export function saleIntentFingerprint(payload: Omit<OfflineSalePayload, 'intentFingerprint'>): string {
  const { intentFingerprint: _ignored, ...intent } = payload as OfflineSalePayload;
  void _ignored;
  const normalized = {
    ...intent,
    customerId: intent.customerId ?? null,
    notes: intent.notes ?? null,
    lines: intent.lines.map(line => ({ ...line, qty: canonicalQuantity(line.qty) })),
    payments: intent.payments.map(payment => ({ ...payment, reference: payment.reference ?? null })),
  };
  const input = stable(normalized);
  let first = 0xcbf29ce484222325n;
  let second = 0x84222325cbf29cen;
  for (let index = 0; index < input.length; index += 1) {
    const code = BigInt(input.charCodeAt(index));
    first = BigInt.asUintN(64, (first ^ code) * 0x100000001b3n);
    second = BigInt.asUintN(64, (second ^ (code + BigInt(index & 255))) * 0x100000001b3n);
  }
  return `intent-v1:${first.toString(16).padStart(16, '0')}${second.toString(16).padStart(16, '0')}`;
}
