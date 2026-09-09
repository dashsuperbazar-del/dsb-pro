import { useEffect, useState } from 'preact/hooks';
import {
  getSession,onAuthStateChange,getCurrentMembership,registerCurrentDevice,classifyError,errorMessage,
  type Session,type Membership,
} from '@dsb-pro/adapters';
import {cacheOfflineMembership,getCachedOfflineMembership} from '@dsb-pro/sync';

export type SessionState =
  | { status: 'loading' }
  | { status: 'signed-out' }
  | { status: 'error'; message: string }
  | { status: 'no-tenant'; session: Session }
  | { status: 'active'; session: Session; membership: Membership; offline: boolean };

export function useSession(): SessionState {
  const [state,setState]=useState<SessionState>({status:'loading'});

  useEffect(()=>{
    let cancelled=false;
    let registeredForUserId:string|null=null;
    let resolutionId=0;

    function setError(error:unknown,context:string,id:number){
      const errorClass=classifyError(error);
      const message=errorMessage(errorClass,error);
      console.error(`useSession: ${context}:`,message);
      if(!cancelled&&id===resolutionId)setState({status:'error',message});
    }

    async function resolve(session:Session|null){
      const id=++resolutionId;
      if(!session){
        if(!cancelled&&id===resolutionId)setState({status:'signed-out'});
        return;
      }

      if(registeredForUserId!==session.user.id){
        registeredForUserId=session.user.id;
        try{
          await registerCurrentDevice();
        }catch(error){
          const message=error instanceof Error?error.message:String(error);
          if(/device revoked/i.test(message)){
            if(!cancelled&&id===resolutionId)setState({status:'error',message:'This device has been revoked. Use an active device or ask the shop owner to review device access.'});
            return;
          }
          // Network failure must not destroy offline access. Membership below
          // will fall back to the last verified cache if the backend is down.
        }
      }

      try{
        const membership=await getCurrentMembership();
        if(cancelled||id!==resolutionId)return;
        if(membership){
          cacheOfflineMembership({userId:session.user.id,tenantId:membership.tenantId,role:membership.role,shopIds:membership.shopIds});
          setState({status:'active',session,membership,offline:false});
        }else setState({status:'no-tenant',session});
      }catch(error){
        const errorClass=classifyError(error);
        if(errorClass==='offline'||errorClass==='server'){
          const cached=getCachedOfflineMembership(session.user.id);
          if(cached&& !cancelled&&id===resolutionId){
            setState({status:'active',session,membership:{tenantId:cached.tenantId,role:cached.role,shopIds:cached.shopIds},offline:true});
            return;
          }
        }
        setError(error,'getCurrentMembership failed',id);
      }
    }

    void getSession().then(resolve).catch(error=>setError(error,'getSession failed',++resolutionId));
    const unsubscribe=onAuthStateChange(session=>{void resolve(session);});
    return()=>{cancelled=true;unsubscribe();};
  },[]);
  return state;
}
