import type { AppendOnlyEventRef,AppendOnlyReconcileResult,MasterMergeOutcome,MasterSyncRow } from './types';

export function isTombstone(row:Pick<MasterSyncRow<unknown>,'deleted_at'>):boolean{
  return row.deleted_at!==null;
}

/**
 * Master data is last-write-wins by the server's updated_at clock, never by a
 * client clock and never by field-wise union. Once a tombstone has been seen,
 * a normal pull cannot resurrect it; restoration needs an explicit future RPC.
 */
export function mergeMasterRow<T>(local:MasterSyncRow<T>|null,remote:MasterSyncRow<T>):MasterMergeOutcome<T>{
  if(!remote.id)throw new Error('remote row id is required');
  if(!Number.isSafeInteger(remote.updated_at)||remote.updated_at<0)throw new Error('remote updated_at is invalid');
  if(!local)return {record:remote,source:'remote',deleted:isTombstone(remote)};
  if(local.id!==remote.id)throw new Error('cannot merge different master rows');
  if(!Number.isSafeInteger(local.updated_at)||local.updated_at<0)throw new Error('local updated_at is invalid');

  // A seen delete is sticky. This prevents stale snapshots or a buggy fallback
  // feed from silently bringing a deleted master row back to life.
  if(isTombstone(local)&&!isTombstone(remote)){
    return {record:local,source:'local',deleted:true};
  }

  if(remote.updated_at>local.updated_at){
    return {record:remote,source:'remote',deleted:isTombstone(remote)};
  }
  if(remote.updated_at<local.updated_at){
    return {record:local,source:'local',deleted:isTombstone(local)};
  }

  // Equal server timestamps are possible. Tombstone wins the tie; otherwise
  // the server copy wins deterministically. There is deliberately no union.
  if(isTombstone(remote)&&!isTombstone(local)){
    return {record:remote,source:'remote',deleted:true};
  }
  return {record:remote,source:'remote',deleted:isTombstone(remote)};
}

/**
 * Financial rows are append-only. clientId is the idempotency identity: an
 * exact retry is accepted, but the same clientId resolving to a different row
 * or payload fingerprint is corruption and must stop sync instead of merging.
 */
export function reconcileAppendOnlyEvent(
  existing:AppendOnlyEventRef|null,
  incoming:AppendOnlyEventRef,
):AppendOnlyReconcileResult{
  if(!incoming.id||!incoming.clientId||!incoming.fingerprint)throw new Error('append-only event identity is incomplete');
  if(!existing)return {action:'insert',event:incoming};
  if(existing.clientId!==incoming.clientId)throw new Error('append-only reconcile requires the same clientId');
  if(existing.id===incoming.id&&existing.fingerprint===incoming.fingerprint){
    return {action:'duplicate',event:existing};
  }
  throw new Error(`append-only collision for clientId ${incoming.clientId}`);
}
