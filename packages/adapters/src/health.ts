import { getSupabaseClient } from './client';
import { classifyError,errorMessage } from './errors';

export type BackupHealth={
  status:string;finished_at:string|null;destinations:{name:string;verified:boolean}[];
  app_version:string|null;schema_version:number|null;
};
const friendly=(error:unknown)=>errorMessage(classifyError(error),error);
export async function getLatestBackupHealth():Promise<BackupHealth|null>{
  const {data,error}=await getSupabaseClient().rpc('get_latest_backup_status');
  if(error)throw new Error(friendly(error));
  const rows=(data??[]) as BackupHealth[];
  return rows[0]??null;
}
