import { relabelRawIds } from './billCodes';
import type { AgingReportV2, PartyLedgerRow, PurchaseRegisterRow } from './reports';

// Display only. Where a report names a purchase bill with no supplier bill no. by its raw uuid, show the
// bill code instead (0069). Ids, amounts and order are untouched; a code that cannot be read leaves the
// report exactly as the server returned it.

export const labelPartyLedger = (rows: PartyLedgerRow[]): Promise<PartyLedgerRow[]> =>
  relabelRawIds(
    rows,
    (r) => r.document,
    (r) => r.document,
    (r, code) => ({ ...r, document: code }),
  );

export const labelPurchaseRegister = (
  rows: PurchaseRegisterRow[],
): Promise<PurchaseRegisterRow[]> =>
  relabelRawIds(
    rows,
    (r) => r.bill_id,
    (r) => r.doc_no,
    (r, code) => ({ ...r, doc_no: code }),
  );

export async function labelSupplierAging(report: AgingReportV2): Promise<AgingReportV2> {
  if (!report || !Array.isArray(report.accounts)) return report;
  const details = report.accounts.flatMap((a) => (Array.isArray(a.details) ? a.details : []));
  const labelled = await relabelRawIds(
    details,
    (d) => d.documentId,
    (d) => d.documentNo,
    (d, code) => ({ ...d, documentNo: code }),
  );
  if (labelled.every((d, i) => d === details[i])) return report;
  const byId = new Map(labelled.map((d) => [d.documentId, d.documentNo]));
  return {
    ...report,
    accounts: report.accounts.map((a) => ({
      ...a,
      details: Array.isArray(a.details)
        ? a.details.map((d) => ({ ...d, documentNo: byId.get(d.documentId) ?? d.documentNo }))
        : a.details,
    })),
  };
}
