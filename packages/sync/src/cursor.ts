import type { ServerSyncRow,SyncCursor } from './types';

function assertCursorPart(value:number,name:string){
  if(!Number.isSafeInteger(value)||value<0)throw new Error(`${name} must be a non-negative safe integer`);
}

export function compareCursor(a:SyncCursor,b:SyncCursor):number{
  assertCursorPart(a.updatedAt,'updatedAt');
  assertCursorPart(b.updatedAt,'updatedAt');
  if(a.updatedAt!==b.updatedAt)return a.updatedAt<b.updatedAt?-1:1;
  if(a.id===b.id)return 0;
  return a.id<b.id?-1:1;
}

export function cursorFromRow(row:Pick<ServerSyncRow,'id'|'updated_at'>):SyncCursor{
  assertCursorPart(row.updated_at,'updated_at');
  if(!row.id)throw new Error('row id is required');
  return {updatedAt:row.updated_at,id:row.id};
}

export function isRowAfterCursor(row:Pick<ServerSyncRow,'id'|'updated_at'>,cursor:SyncCursor):boolean{
  return compareCursor(cursorFromRow(row),cursor)>0;
}

export function advanceCursor(cursor:SyncCursor,rows:ReadonlyArray<Pick<ServerSyncRow,'id'|'updated_at'>>):SyncCursor{
  let next=cursor;
  for(const row of rows){
    const candidate=cursorFromRow(row);
    if(compareCursor(candidate,next)>0)next=candidate;
  }
  return next;
}
