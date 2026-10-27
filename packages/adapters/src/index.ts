export { getSupabaseClient } from './client';
export {
  listPurchaseHistory,
  getPurchaseDetail,
  getPurchaseEditLinks,
  listSupplierPurchaseLines,
} from './purchases';
export type {
  PurchaseEditLinks,
  PurchaseRecord,
  PurchaseHistoryLine,
  PurchaseBalance,
  SupplierPurchaseLine,
} from './purchases';
export type { ErrorClass } from './errors';
export { classifyError, errorMessage } from './errors';
export {
  signUp,
  signIn,
  signOut,
  getSession,
  ensureFreshSession,
  onAuthStateChange,
  isEmailVerified,
  resendVerificationEmail,
  resetPasswordForEmail,
} from './auth';
export type { Session } from './auth';
export type { Membership, Invite, TenantUser } from './tenancy';
export {
  createTenant,
  getDefaultShopId,
  createInvite,
  revokeInvite,
  acceptInvite,
  setUserRole,
  setUserStatus,
  removeTenantUser,
  getCurrentMembership,
  listTenantUsers,
  listInvites,
} from './tenancy';
export type { Device } from './devices';
export {
  getOrCreateDeviceId,
  guessDeviceLabel,
  registerCurrentDevice,
  listDevices,
  renameDevice,
  revokeDevice,
} from './devices';
export type { Item, Party, StockRow, PurchaseLine, ItemBarcode } from './masterData';
export { getProfitReport, FREE_TEXT_REPORT_NAME } from './profit';
export type { ProfitReport, ProfitSummary, ProfitItem } from './profit';
export {
  normalizePartyDetails,
  updateParty,
  updateCustomer,
  archiveParty,
  archiveCustomer,
} from './partyEdit';
export type { PartyDetailsInput, NormalizedPartyDetails } from './partyEdit';
export {
  listItems,
  listParties,
  createItem,
  itemNameTakenMessage,
  createParty,
  addItemBarcode,
  findItemByBarcode,
  listStock,
  listBelowZeroStock,
  getShopBusinessDate,
  postPurchase,
  voidPurchase,
  archiveMaster,
  uploadItemImage,
  purgeItemImage,
  setItemMinStock,
  setItemTaxRate,
} from './masterData';
export type { ItemPrice } from './pricing';
export { listCurrentPrices, listRetailPrices, PriceRefusedError, setItemPrice } from './pricing';
export { replaceItemImage } from './itemImages';
export type {
  Customer,
  SaleLineInput,
  SalePaymentInput,
  SaleInvoice,
  CustomerBalance,
  PaymentAllocationInput,
  CustomerLedgerRow,
  SaleReceipt,
  SaleReceiptLine,
  SaleReceiptPayment,
} from './sales';
export {
  listCustomers,
  createCustomer,
  postSale,
  voidSale,
  recordCustomerPayment,
  voidPayment,
  listRecentSales,
  listCustomerBalances,
  listCustomerLedger,
  readCustomerLedgerForStatement,
  listOpenCustomerSales,
  getSaleReceipt,
} from './sales';
export type { CustomerOutstandingInvoice } from './receivables';
export { listCustomerOutstandingInvoices } from './receivables';

export type { LegacyDsbImportSummary } from './legacyImport';
export { importLegacyDsbMaster } from './legacyImport';

export type {
  ShopDayReconciliation,
  DayReconciliationPaymentModes,
  DayReconciliationSoldItem,
} from './reconciliation';
export { getShopDayReconciliation } from './reconciliation';

export type {
  SyncCursorWire,
  SyncPullWire,
  SyncPullTable,
  SyncSaleResultWire,
  ServerSyncConflict,
  SaleLineExtras,
} from './sync';
export {
  SYNC_SCHEMA_VERSION,
  SYNC_PULL_LIMITS,
  syncPullMayHaveMore,
  isolateSyncPullCursors,
  pullSync,
  pullSyncTable,
  ackSync,
  pushSyncedSale,
  setOfflineCashierFinalization,
  recordServerSyncConflict,
  listServerSyncConflicts,
  resolveServerSyncConflict,
  subscribeSyncWakeup,
} from './sync';

export type {
  DayBookRow,
  StockValueRow,
  GstRow,
  PartyLedgerRow,
  InvariantHealth,
  LowStockRow,
  ItemSalesRow,
  PurchaseRegisterRow,
  CustomerAgingRow,
  AgingReportV2,
  AgingAccountV2,
  AgingDetailV2,
  DayBookText,
  RecentExpense,
} from './reports';
export {
  getDayBook,
  getStockValuation,
  getGstSummary,
  postExpense,
  voidExpense,
  listRecentExpenses,
  exportTenant,
  checkInvariants,
  getPartyLedger,
  createStockCount,
  postStockCount,
  getLowStockReport,
  getItemSalesReport,
  getPurchaseRegister,
  getCustomerAgingReport,
  getAgingReportV2,
  getDayBookText,
  listStockText,
} from './reports';

export type { BackupHealth } from './health';
export { getLatestBackupHealth } from './health';
export type {
  ReturnType,
  ReturnDisposition,
  ReturnSource,
  ReturnableLine,
  PostedReturn,
  ReturnLineInput,
} from './returns';
export {
  listReturnSources,
  listReturnableLines,
  postReturn,
  listRecentReturns,
  getPurchaseReturnRoundOffs,
  voidReturn,
  pullReturnSources,
  pushSyncedReturn,
  pushSyncedReturnVoid,
} from './returns';

export type { PrinterWidth, ShopSettings, ShopSettingsInput } from './shopSettings';
export { getShopSettings, updateShopSettings } from './shopSettings';

export type {
  SupplierOperation,
  CustomerOperation,
  FinancialOperation,
  SaleAllocation,
  PaymentMode,
  SupplierAllocation,
  SupplierWriteOutcome,
  SupplierRequestLookup,
  SupplierOutstandingRow,
  SupplierBill,
  SupplierPayment,
  SupplierLedger,
  SupplierLedgerEntry,
} from './supplierPayments';
export {
  recordCustomerPaymentV2,
  allocateCustomerPaymentV2,
  lookupFinancialRequest,
  recordSupplierPayment,
  allocateSupplierPayment,
  voidSupplierPayment,
  releaseSupplierAllocation,
  lookupSupplierRequest,
  getSupplierOutstanding,
  listSupplierBills,
  listSupplierBillsForDuplicateCheck,
  listSupplierPayments,
  listSupplierAllocations,
  getSupplierLedger,
} from './supplierPayments';
export type { WriteOutcome, PurchaseRequest, StockCountRequest } from './outcomes';
export { postExpenseOutcome, postPurchaseOutcome, postStockCountOutcome } from './outcomes';
export type { AccountOpening } from './outcomes';
export { recordOpeningOutcome, voidOpeningOutcome, listOpenings } from './outcomes';
export type { SettlementOptions } from './outcomes';
export { settleOpeningOutcome, voidSettlementOutcome, getSettlementOptions } from './outcomes';

export {
  billDocumentPath,
  billDocumentHash,
  readBillDocument,
  uploadBillDocument,
  BILL_DOCUMENT_PATH,
} from './billDocuments';
export type { BillDocument } from './billDocuments';
export {
  listSupplierSchedules,
  saveSupplierSchedule,
  removeSupplierSchedule,
  getSupplierPaymentsDue,
} from './supplierSchedule';
export type { SupplierSchedule, SupplierPaymentDue } from './supplierSchedule';
export { mergeParties, listSupplierDuplicateBills, getPartyMergePreview } from './partyMerge';
export type { DuplicateBillGroup, MergePreview } from './partyMerge';
export { listItemPurchasePrices } from './priceHistory';
export type { ItemPurchasePrice } from './priceHistory';
export { listItemSaleMovements } from './demand';
export type { ItemSaleMovements, SaleMovement } from './demand';
export type {
  PurchaseEditRequest,
  PurchaseEditResult,
  PurchaseExtras,
  PurchaseRequestLookup,
  PurchaseSettlement,
  PurchaseV2Line,
  PurchaseV2Request,
  PurchaseV2Result,
} from './purchaseExtras';
export {
  buildPurchaseV2Payload,
  deriveSettlement,
  editPurchaseBillOutcome,
  getPurchaseExtras,
  lookupPurchaseRequest,
  plainEditRefusal,
  postPurchaseV2Outcome,
  voidPaidPurchaseOutcome,
} from './purchaseExtras';
export type { PurchaseVoidInfo } from './purchaseVoid';
export {
  VOID_REASON_MAX,
  getPurchaseVoidInfo,
  listPurchaseSettlements,
  parsePurchaseVoidId,
  purchaseVoidRequestId,
  voidPurchaseOutcome,
} from './purchaseVoid';
export {
  listDocumentRemarks,
  listOpenRemarks,
  listRemarkHistory,
  addRemarkOutcome,
  editRemarkOutcome,
  settleRemarkOutcome,
  reopenRemarkOutcome,
  plainRemarkRefusal,
  normalizeRemark,
  REMARK_MAX_LENGTH,
  OPEN_REMARKS_CAP,
  openRemarksCapped,
  savedRemarkClientIds,
} from './remarks';
export type {
  DocumentRemark,
  OpenRemark,
  RemarkEvent,
  RemarkDocKind,
  RemarkStatus,
} from './remarks';
export {
  listAuditEvents,
  auditFilter,
  AUDIT_TYPES,
  AUDIT_TYPE_LABEL,
  AUDIT_PAGE_SIZE,
} from './auditLog';
export type { AuditEvent, AuditQuery, AuditType } from './auditLog';
export {
  readBillCodes,
  relabelRawIds,
  withBillCode,
  resetBillCodeSupport,
  findBillsByCode,
} from './billCodes';
export type { BillCodeHit } from './billCodes';
export { labelPartyLedger, labelPurchaseRegister, labelSupplierAging } from './reportLabels';
export { createItemV2Outcome, plainItemRefusal } from './offlineItems';
export type { CreateItemV2Input, CreateItemV2Result } from './offlineItems';
export {
  getPurchaseBillVersion,
  voidPurchaseIfUnchangedOutcome,
  plainOfflineVoidRefusal,
} from './offlineBillChanges';
export {
  getSupplierPayContext,
  paySupplierIfUnchangedOutcome,
  plainOfflineSupplierPaymentRefusal,
} from './offlineSupplierPayments';
export type {
  PaySupplierIfUnchangedInput,
  PaySupplierResult,
  SupplierPayContext,
  SupplierPayContextBill,
  SupplierPayContextSupplier,
} from './offlineSupplierPayments';
