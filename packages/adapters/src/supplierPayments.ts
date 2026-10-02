import { getSupabaseClient } from './client';
import { classifyError, errorMessage } from './errors';
import { definitiveCode } from './outcomes';

// C2 supplier-payment adapter. Writes return a three-way outcome instead of throwing, so the caller's
// durable attempt store can tell a definitive rejection (rolled back) from an unknown outcome (the
// request may have committed). Acknowledgments are validated before they are trusted.
export type SupplierOperation =
  'supplier.record.v1' | 'supplier.allocate.v1' | 'supplier.void.v1' | 'supplier.release.v1';
// C3: customer receipts use the same request ledger and outcome model.
export type CustomerOperation = 'record_customer_payment_v2' | 'allocate_customer_payment_v2';
export type FinancialOperation = SupplierOperation | CustomerOperation;
export type SaleAllocation = { saleInvoiceId: string; amountPaise: string };
export type PaymentMode = 'cash' | 'upi' | 'card' | 'bank' | 'other';
export type SupplierAllocation = { purchaseBillId: string; amountPaise: string };
export type SupplierWriteOutcome =
  | { kind: 'committed'; result: Record<string, unknown> }
  | { kind: 'rejected'; code: string; message: string }
  | { kind: 'unknown'; message: string };
export type SupplierRequestLookup =
  | { kind: 'committed'; result: Record<string, unknown>; currentStatus: string | null }
  | { kind: 'not_found' }
  | { kind: 'unavailable'; message: string };
export type SupplierOutstandingRow = {
  partyId: string;
  partyName: string;
  grossOpenBills: string;
  unallocatedCashAdvances: string;
  returnCredits: string;
  netLedgerBalance: string;
  strandedAllocationsOnVoidBills: number;
};
export type SupplierBill = {
  purchase_bill_id: string;
  bill_no: string | null;
  business_date: string;
  total_paise: number;
  returned_paise: number;
  allocated_paise: number;
  outstanding_paise: number;
};
export type SupplierPayment = {
  id: string;
  business_date: string;
  amount_paise: number;
  mode: PaymentMode;
  reference: string | null;
  status: 'POSTED' | 'VOID';
  created_at: string;
  allocated_paise: number;
};
export type SupplierLedgerEntry = {
  date: string;
  kind: string;
  document: string;
  id: string;
  amountPaise: string;
  runningBalancePaise: string;
};
export type SupplierLedger = {
  openingBalancePaise: string;
  closingBalancePaise: string;
  entries: SupplierLedgerEntry[];
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const INT_TEXT = /^-?\d+$/;
const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID.test(v);
const friendly = (error: unknown) => errorMessage(classifyError(error), error);

function validateAck(operation: FinancialOperation, data: unknown): Record<string, unknown> | null {
  if (
    operation === 'supplier.record.v1' ||
    operation === 'supplier.void.v1' ||
    operation === 'record_customer_payment_v2'
  ) {
    // record/void return the payment id (record) or a jsonb result (void); normalize both.
    if (isUuid(data)) return { paymentId: data };
  }
  if (operation === 'supplier.release.v1' && isUuid(data)) return { allocationId: data };
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  const r = data as Record<string, unknown>;
  if (!isUuid(r.paymentId)) return null;
  if (
    r.allocationIds !== undefined &&
    !(Array.isArray(r.allocationIds) && r.allocationIds.every(isUuid))
  )
    return null;
  return r;
}

async function write(
  operation: FinancialOperation,
  fn: string,
  args: Record<string, unknown>,
): Promise<SupplierWriteOutcome> {
  let response: { data: unknown; error: { code?: string; message?: string } | null };
  try {
    response = (await getSupabaseClient().rpc(fn as never, args as never)) as typeof response;
  } catch (error) {
    return { kind: 'unknown', message: error instanceof Error ? error.message : String(error) };
  }
  if (response.error) {
    const code = definitiveCode(response.error);
    if (code) return { kind: 'rejected', code, message: response.error.message ?? code };
    return { kind: 'unknown', message: response.error.message ?? 'No answer from the server.' };
  }
  const result = validateAck(operation, response.data);
  if (!result)
    return {
      kind: 'unknown',
      message: 'The server answer could not be verified; checking by request ID.',
    };
  return { kind: 'committed', result };
}

const allocs = (list: SupplierAllocation[]) =>
  list.map((a) => {
    if (!isUuid(a.purchaseBillId) || !/^\d+$/.test(a.amountPaise))
      throw new Error('Invalid bill allocation.');
    return { purchase_bill_id: a.purchaseBillId, amount_paise: Number(a.amountPaise) };
  });

export function recordSupplierPayment(input: {
  requestId: string;
  shopId: string;
  partyId: string;
  businessDate: string | null;
  amountPaise: string;
  mode: PaymentMode;
  reference?: string | null;
  allocations: SupplierAllocation[];
}) {
  return write('supplier.record.v1', 'record_supplier_payment', {
    p_shop_id: input.shopId,
    p_party_id: input.partyId,
    p_business_date: input.businessDate,
    p_amount_paise: Number(input.amountPaise),
    p_mode: input.mode,
    p_reference: input.reference ?? null,
    p_allocations: allocs(input.allocations),
    p_client_id: input.requestId,
  });
}
export function allocateSupplierPayment(input: {
  requestId: string;
  paymentId: string;
  allocations: SupplierAllocation[];
}) {
  return write('supplier.allocate.v1', 'allocate_supplier_payment', {
    p_payment_id: input.paymentId,
    p_allocations: allocs(input.allocations),
    p_client_id: input.requestId,
  });
}
export function voidSupplierPayment(input: {
  requestId: string;
  paymentId: string;
  reason: string;
}) {
  return write('supplier.void.v1', 'void_supplier_payment', {
    p_payment_id: input.paymentId,
    p_reason: input.reason,
    p_client_id: input.requestId,
  });
}
export function releaseSupplierAllocation(input: {
  requestId: string;
  allocationId: string;
  reason: string;
}) {
  return write('supplier.release.v1', 'release_supplier_allocation', {
    p_allocation_id: input.allocationId,
    p_reason: input.reason,
    p_client_id: input.requestId,
  });
}

export async function lookupSupplierRequest(
  shopId: string,
  operation: FinancialOperation,
  requestId: string,
): Promise<SupplierRequestLookup> {
  try {
    const { data, error } = await getSupabaseClient().rpc(
      'get_financial_request' as never,
      { p_shop_id: shopId, p_operation: operation, p_client_id: requestId } as never,
    );
    if (error) return { kind: 'unavailable', message: friendly(error) };
    const r = data as { state?: string; result?: unknown; currentStatus?: string | null } | null;
    if (r?.state === 'NOT_FOUND') return { kind: 'not_found' };
    if (r?.state === 'COMMITTED') {
      // Same acknowledgment check as a direct write: an unverifiable status answer keeps UNKNOWN.
      const result = validateAck(operation, r.result);
      if (!result)
        return { kind: 'unavailable', message: 'The request-status answer could not be verified.' };
      return { kind: 'committed', result, currentStatus: r.currentStatus ?? null };
    }
    return { kind: 'unavailable', message: 'Unexpected request-status answer.' };
  } catch (error) {
    return { kind: 'unavailable', message: error instanceof Error ? error.message : String(error) };
  }
}

export async function getSupplierOutstanding(shopId: string): Promise<SupplierOutstandingRow[]> {
  const { data, error } = await getSupabaseClient().rpc(
    'get_supplier_outstanding' as never,
    { p_shop_id: shopId } as never,
  );
  if (error) throw new Error(friendly(error));
  const rows = (data as { parties?: unknown } | null)?.parties;
  if (!Array.isArray(rows)) throw new Error('Malformed supplier outstanding report.');
  for (const r of rows as SupplierOutstandingRow[]) {
    if (
      !isUuid(r.partyId) ||
      ![r.grossOpenBills, r.unallocatedCashAdvances, r.returnCredits, r.netLedgerBalance].every(
        (v) => INT_TEXT.test(String(v)),
      )
    )
      throw new Error('Malformed supplier outstanding report.');
  }
  return rows as SupplierOutstandingRow[];
}

export async function listSupplierBills(shopId: string, partyId: string): Promise<SupplierBill[]> {
  const { data, error } = await getSupabaseClient()
    .from('purchase_bill_outstanding' as never)
    .select(
      'purchase_bill_id,bill_no,business_date,total_paise,returned_paise,allocated_paise,outstanding_paise',
    )
    .eq('shop_id', shopId)
    .eq('party_id', partyId)
    .order('business_date')
    .order('purchase_bill_id');
  if (error) throw new Error(friendly(error));
  return (data ?? []) as unknown as SupplierBill[];
}

export async function listSupplierPayments(
  shopId: string,
  partyId: string,
): Promise<SupplierPayment[]> {
  const { data, error } = await getSupabaseClient()
    .from('payments')
    .select(
      'id,business_date,amount_paise,mode,reference,status,created_at,payment_allocations(amount_paise,status),opening_settlements(amount_paise,status)',
    )
    .eq('shop_id', shopId)
    .eq('party_id', partyId)
    .eq('kind', 'party')
    .eq('direction', 'out')
    .order('business_date', { ascending: false })
    .order('created_at', { ascending: false });
  if (error) throw new Error(friendly(error));
  return (
    (data ?? []) as unknown as Array<
      Omit<SupplierPayment, 'allocated_paise'> & {
        payment_allocations: { amount_paise: number; status: string }[];
        opening_settlements?: { amount_paise: number; status: string }[] | null;
      }
    >
  ).map(({ payment_allocations, opening_settlements, ...p }) => ({
    ...p,
    // O3: cash settled against an opening balance (O2) is assigned too, so it is never offered again.
    allocated_paise: [...payment_allocations, ...(opening_settlements ?? [])]
      .filter((a) => a.status === 'POSTED')
      .reduce((s, a) => s + a.amount_paise, 0),
  }));
}

export async function listSupplierAllocations(paymentId: string): Promise<
  Array<{
    id: string;
    purchase_bill_id: string;
    amount_paise: number;
    status: string;
    effective_date: string;
  }>
> {
  const { data, error } = await getSupabaseClient()
    .from('payment_allocations')
    .select('id,purchase_bill_id,amount_paise,status,effective_date')
    .eq('payment_id', paymentId)
    .not('purchase_bill_id', 'is', null);
  if (error) throw new Error(friendly(error));
  return (data ?? []) as never;
}

export async function getSupplierLedger(
  shopId: string,
  partyId: string,
  from?: string | null,
  to?: string | null,
): Promise<SupplierLedger> {
  const { data, error } = await getSupabaseClient().rpc(
    'get_party_ledger_v2' as never,
    { p_shop_id: shopId, p_party_id: partyId, p_from: from ?? null, p_to: to ?? null } as never,
  );
  if (error) throw new Error(friendly(error));
  const r = data as SupplierLedger | null;
  if (
    !r ||
    !Array.isArray(r.entries) ||
    !INT_TEXT.test(r.openingBalancePaise) ||
    !INT_TEXT.test(r.closingBalancePaise)
  )
    throw new Error('Malformed supplier ledger.');
  return r;
}

const saleAllocs = (list: SaleAllocation[]) =>
  list.map((a) => {
    if (!isUuid(a.saleInvoiceId) || !/^\d+$/.test(a.amountPaise))
      throw new Error('Invalid invoice allocation.');
    return { sale_invoice_id: a.saleInvoiceId, amount_paise: Number(a.amountPaise) };
  });
export function recordCustomerPaymentV2(input: {
  requestId: string;
  shopId: string;
  customerId: string;
  businessDate: string | null;
  amountPaise: string;
  mode: PaymentMode;
  reference?: string | null;
  allocations: SaleAllocation[];
}) {
  return write('record_customer_payment_v2', 'record_customer_payment_v2', {
    p_shop_id: input.shopId,
    p_customer_id: input.customerId,
    p_business_date: input.businessDate,
    p_amount_paise: Number(input.amountPaise),
    p_mode: input.mode,
    p_reference: input.reference ?? null,
    p_allocations: saleAllocs(input.allocations),
    p_client_id: input.requestId,
  });
}
export function allocateCustomerPaymentV2(input: {
  requestId: string;
  paymentId: string;
  allocations: SaleAllocation[];
}) {
  return write('allocate_customer_payment_v2', 'allocate_customer_payment_v2', {
    p_payment_id: input.paymentId,
    p_allocations: saleAllocs(input.allocations),
    p_client_id: input.requestId,
  });
}
export const lookupFinancialRequest = lookupSupplierRequest;
