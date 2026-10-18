import Dexie, { type Table } from 'dexie';

// SP4: display-only screen snapshots kept on disk so a cold start can show the last list at once.
// Never read by any money/stock path. One small device-wide database; every row carries its user id and
// the reader filters by the signed-in user, wiping rows of any other user.
export type RouteSnapshotRow = {
  key: string; // `${userId}:${name}`
  userId: string;
  name: string;
  shopId: string;
  at: number;
  json: string;
  size: number;
};

export class RouteSnapshotDb extends Dexie {
  snapshots!: Table<RouteSnapshotRow, string>;
  constructor(name = 'dsb-pro-route-snapshots') {
    super(name);
    this.version(1).stores({ snapshots: '&key,userId,at' });
  }
}

let db: RouteSnapshotDb | null = null;
export async function openRouteSnapshotDb(): Promise<RouteSnapshotDb> {
  if (!db) db = new RouteSnapshotDb();
  if (!db.isOpen()) await db.open();
  return db;
}
