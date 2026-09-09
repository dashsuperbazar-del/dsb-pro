import {useEffect} from 'preact/hooks';
import type {SessionState} from '../lib/useSession';
import {startOfflineSync,stopOfflineSync} from '../lib/offlineSync';

export function SyncRuntime({session}:{session:SessionState}){
  useEffect(()=>{
    if(session.status!=='active'){stopOfflineSync();return;}
    void startOfflineSync({userId:session.session.user.id,membership:session.membership});
    return ()=>stopOfflineSync();
  },[session.status,session.status==='active'?session.session.user.id:'',session.status==='active'?session.membership.tenantId:'']);
  return null;
}
