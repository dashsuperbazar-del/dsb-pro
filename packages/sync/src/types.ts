export type SyncCursor = Readonly<{
  updatedAt:number;
  id:string;
}>;

export type ServerSyncRow = Readonly<{
  id:string;
  updated_at:number;
  deleted_at:number|null;
}>;

export type MasterSyncRow<T> = ServerSyncRow & Readonly<{
  data:T;
}>;

export type AppendOnlyEventRef = Readonly<{
  id:string;
  clientId:string;
  fingerprint:string;
}>;

export type OutboxKind = 'financial-rpc'|'master-upsert'|'master-delete';
export type OutboxState = 'pending'|'sending'|'retry';

export type OutboxEntry<T=unknown> = Readonly<{
  sequence:number;
  clientId:string;
  kind:OutboxKind;
  target:string;
  payload:T;
  createdAt:number;
  attempts:number;
  state:OutboxState;
  nextAttemptAt:number;
  lastError:string|null;
}>;

export type MasterMergeOutcome<T> = Readonly<{
  record:MasterSyncRow<T>;
  source:'local'|'remote';
  deleted:boolean;
}>;

export type AppendOnlyReconcileResult =
  | Readonly<{action:'insert';event:AppendOnlyEventRef}>
  | Readonly<{action:'duplicate';event:AppendOnlyEventRef}>;

export type OfflineRole='owner'|'manager'|'cashier'|'accountant';
export type SyncTableName='items'|'barcodes'|'prices'|'customers'|'stock';

export type SyncedItem=ServerSyncRow&{
  tenant_id:string; name:string; sku:string|null; unit1:string; unit2:string|null; unit3:string|null;
  conv1:number|null; conv2:number|null; tax_rate_bp:number; min_stock:number; image_path:string|null; is_active:boolean;
};
export type SyncedBarcode=ServerSyncRow&{
  tenant_id:string; item_id:string; barcode:string; unit_level:1|2|3;
};
export type SyncedPrice=ServerSyncRow&{
  tenant_id:string; item_id:string; shop_id:string|null; kind:'retail'|'wholesale'|'mrp'|'cost_last';
  unit_level:1|2|3; price_paise:number; effective_from:string; effective_to:string|null;
};
export type SyncedCustomer=ServerSyncRow&{
  tenant_id:string; name:string; phone:string|null; address:string|null; gstin:string|null;
  credit_limit_paise:number; notes:string|null;
};
export type SyncedStock=ServerSyncRow&{
  key:string; tenant_id:string; shop_id:string; item_id:string; on_hand:number; reserved:number; available:number; qty_base:number;
};

export type SyncPolicy=Readonly<{allowCashierOfflineFinalization:boolean}>;
export type SyncPullPayload=Readonly<{
  schemaVersion:number;
  serverNowMs:number;
  cutoffMs:number;
  businessDate:string;
  policy:SyncPolicy;
  items:SyncedItem[];
  barcodes:SyncedBarcode[];
  prices:SyncedPrice[];
  customers:SyncedCustomer[];
  stock:SyncedStock[];
}>;

export type SyncIdentity=Readonly<{
  userId:string;
  tenantId:string;
  shopId:string;
  deviceId:string;
  role:OfflineRole;
}>;

export type OfflineSaleLineInput=Readonly<{
  itemId:string; unitLevel:1|2|3; qty:number; priceKind:'retail'|'wholesale'; discountPaise:number;
}>;
export type OfflineSalePaymentInput=Readonly<{
  amountPaise:number; mode:'cash'|'upi'|'card'|'bank'|'other'; reference?:string;
}>;
export type OfflineSalePayload=Readonly<{
  shopId:string; customerId?:string; businessDate:string; discountPaise:number; extraChargesPaise:number;
  clientId:string; lines:OfflineSaleLineInput[]; payments:OfflineSalePaymentInput[]; notes?:string;
}>;
export type OfflineSaleLineSnapshot=OfflineSaleLineInput&Readonly<{
  itemName:string; unitName:string; unitPricePaise:number; baseQty:number; lineTotalPaise:number;
}>;
export type OfflineSaleStatus='QUEUED'|'SYNCED'|'REJECTED';
export type OfflineSaleRecord=Readonly<{
  clientId:string; provisionalDocNo:string; officialSaleId:string|null; officialDocNo:string|null;
  shopId:string; customerId:string|null; businessDate:string; subtotalPaise:number; discountPaise:number;
  extraChargesPaise:number; totalPaise:number; payments:OfflineSalePaymentInput[]; lines:OfflineSaleLineSnapshot[];
  status:OfflineSaleStatus; createdAt:number; syncedAt:number|null; rejectionReason:string|null;
}>;

export type LocalReservation=Readonly<{key:string;shop_id:string;item_id:string;qty:number}>;
export type LocalMeta=Readonly<{key:string;value:unknown}>;
export type SyncConflictStatus='OPEN'|'RESOLVED';
export type LocalSyncConflict=Readonly<{
  id?:number; createdAt:number; status:SyncConflictStatus; kind:string; target:string; clientId:string|null;
  reason:string; payload:unknown; serverRef:unknown;
}>;

export type CachedOfflineMembership=Readonly<{
  userId:string; tenantId:string; role:OfflineRole; shopIds:string[]; cachedAt:number;
}>;

export type SyncHealth=Readonly<{
  outboxCount:number; conflictCount:number; queuedSales:number; lastSyncAt:number|null;
  lastServerNowMs:number|null; clockDriftMs:number|null; businessDate:string|null;
}>;

export type SyncedSaleResult=Readonly<{
  saleId:string; docNo:string; stock:SyncedStock[];
}>;
