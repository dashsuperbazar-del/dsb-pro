export { getSupabaseClient } from './client';
export type { ErrorClass } from './errors';
export { classifyError, errorMessage } from './errors';
export { signUp, signIn, signOut, getSession, ensureFreshSession, onAuthStateChange, isEmailVerified, resendVerificationEmail, resetPasswordForEmail } from './auth';
export type { Session } from './auth';
export type { Membership, Invite, TenantUser } from './tenancy';
export { createTenant, getDefaultShopId, createInvite, revokeInvite, acceptInvite, setUserRole, setUserStatus, removeTenantUser, getCurrentMembership, listTenantUsers, listInvites } from './tenancy';
export type { Device } from './devices';
export { getOrCreateDeviceId, guessDeviceLabel, registerCurrentDevice, listDevices, renameDevice, revokeDevice } from './devices';
export type { Item, Party, StockRow, PurchaseLine, ItemBarcode } from './masterData';
export { listItems, listParties, createItem, createParty, addItemBarcode, findItemByBarcode, listStock, getShopBusinessDate, postPurchase, voidPurchase, archiveMaster, uploadItemImage, purgeItemImage, setItemMinStock } from './masterData';
export type { ItemPrice } from './pricing';
export { listCurrentPrices, setItemPrice } from './pricing';
export { replaceItemImage } from './itemImages';
export type { Customer, SaleLineInput, SalePaymentInput, SaleInvoice, CustomerBalance, PaymentAllocationInput, CustomerLedgerRow, SaleReceipt, SaleReceiptLine, SaleReceiptPayment } from './sales';
export { listCustomers, createCustomer, postSale, voidSale, recordCustomerPayment, voidPayment, listRecentSales, listCustomerBalances, listCustomerLedger, listOpenCustomerSales, getSaleReceipt } from './sales';
export type { CustomerOutstandingInvoice } from './receivables';
export { listCustomerOutstandingInvoices } from './receivables';

export type { LegacyDsbImportSummary } from './legacyImport';
export { importLegacyDsbMaster } from './legacyImport';

export type { ShopDayReconciliation, DayReconciliationPaymentModes, DayReconciliationSoldItem } from './reconciliation';
export { getShopDayReconciliation } from './reconciliation';

export type { SyncCursorWire, SyncPullWire, SyncPullTable, SyncSaleResultWire, ServerSyncConflict } from './sync';
export { SYNC_SCHEMA_VERSION, SYNC_PULL_LIMITS, syncPullMayHaveMore, isolateSyncPullCursors, pullSync, pullSyncTable, ackSync, pushSyncedSale, setOfflineCashierFinalization, recordServerSyncConflict, listServerSyncConflicts, resolveServerSyncConflict, subscribeSyncWakeup } from './sync';

export type { DayBookRow, StockValueRow, GstRow, PartyLedgerRow, InvariantHealth, LowStockRow, ItemSalesRow, PurchaseRegisterRow, CustomerAgingRow } from './reports';
export { getDayBook, getStockValuation, getGstSummary, postExpense, voidExpense, exportTenant, checkInvariants, getPartyLedger, createStockCount, postStockCount, getLowStockReport, getItemSalesReport, getPurchaseRegister, getCustomerAgingReport } from './reports';

export type { BackupHealth } from './health';
export { getLatestBackupHealth } from './health';
export type { ReturnType, ReturnDisposition, ReturnSource, ReturnableLine, PostedReturn, ReturnLineInput } from './returns';
export { listReturnSources, listReturnableLines, postReturn, listRecentReturns, voidReturn, pullReturnSources, pushSyncedReturn, pushSyncedReturnVoid } from './returns';

export type { PrinterWidth, ShopSettings, ShopSettingsInput } from './shopSettings';
export { getShopSettings, updateShopSettings } from './shopSettings';
