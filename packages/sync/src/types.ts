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
