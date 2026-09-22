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

export type SyncPolicy=Readonly<{
  allowCashierOfflineFinalization:boolean;
  allowNegativeStock:boolean;
  canViewCostPrices:boolean;
}>;
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
  itemId:string; unitLevel:1|2|3; qty:string|number; priceKind:'retail'|'wholesale'; discountPaise:number; expectedUnitPricePaise?:number;
}>;
export type OfflineSalePaymentInput=Readonly<{
  amountPaise:number; mode:'cash'|'upi'|'card'|'bank'|'other'; reference?:string;
}>;
export type OfflineSalePayload=Readonly<{
  shopId:string; customerId?:string; businessDate:string; discountPaise:number; extraChargesPaise:number;
  clientId:string; lines:OfflineSaleLineInput[]; payments:OfflineSalePaymentInput[]; notes?:string; intentFingerprint?:string;
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
  intentFingerprint?:string; provisionalTotals?:Readonly<{subtotalPaise:number;discountPaise:number;extraChargesPaise:number;totalPaise:number}>;
  reconciliationWarning?:string|null; reconciliationReviewedAt?:number|null;
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
  saleId:string; docNo:string; clientId:string; intentFingerprint:string; stock:SyncedStock[];
  subtotalPaise:number; discountPaise:number; extraChargesPaise:number; totalPaise:number;
  lines:ReadonlyArray<Readonly<{
    itemId:string;unitLevel:1|2|3;qty:string;priceKind:'retail'|'wholesale';unitPricePaise:number;discountPaise:number;lineTotalPaise:number;
  }>>;
  payments:OfflineSalePaymentInput[];
}>;

export type HeldCartLine={itemId:string;unitLevel:1|2|3;qty:string|number;priceKind:'retail'|'wholesale';discountPaise:number};
export type HeldCartRecord={
  id:string;shopId:string;createdAt:number;label:string;customerId:string;globalDiscount:string;extra:string;lines:HeldCartLine[];
  resumeToken?:string|null;resumingAt?:number|null;
};

export type OfflineReturnType='SALE'|'PURCHASE';
export type OfflineReturnDisposition='RETURN_TO_SELLABLE'|'DAMAGED'|'EXPIRED'|'SUPPLIER_RETURN';
export type CachedReturnLine={id:string;item_id:string;item_name_snapshot:string;unit_name_snapshot:string;qty:number;base_qty:number;returned_qty:number};
export type CachedReturnSource={key:string;return_type:OfflineReturnType;id:string;shop_id:string;doc_no:string;business_date:string;total_paise:number;party_name:string|null;customer_name:string|null;posted_return_client_ids:string[];lines:CachedReturnLine[]};
export type OfflineReturnPayload={type:OfflineReturnType;sourceId:string;shopId:string;businessDate:string;clientId:string;lines:{sourceLineId:string;qty:number;disposition:OfflineReturnDisposition}[];notes?:string};
export type OfflineReturnRecord={clientId:string;provisionalDocNo:string;payload:OfflineReturnPayload;fingerprint:string;shopId:string;status:'QUEUED'|'SYNCED'|'REJECTED'|'VOID';createdAt:number;officialReturnId:string|null;officialDocNo:string|null;cashRefundPaise:number|null;balanceCreditPaise:number|null;totalPaise:number|null;rejectionReason:string|null;lines:{sourceLineId:string;itemId:string;qty:number;stockDelta:number}[]};
export type SyncedReturnResult={returnId:string;docNo:string;status:'POSTED'|'VOID';totalPaise:number;cashRefundPaise:number;balanceCreditPaise:number;stock:SyncedStock[]};
