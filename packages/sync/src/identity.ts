import type {CachedOfflineMembership,OfflineRole} from './types';

const KEY='dsb-pro-offline-membership-v1';

function storage():Storage|null{
  return typeof localStorage==='undefined'?null:localStorage;
}
export function cacheOfflineMembership(input:{userId:string;tenantId:string;role:OfflineRole;shopIds:string[]}):void{
  const s=storage(); if(!s)return;
  const all=readAll();
  all[input.userId]={...input,shopIds:[...input.shopIds],cachedAt:Date.now()};
  s.setItem(KEY,JSON.stringify(all));
}
export function getCachedOfflineMembership(userId:string):CachedOfflineMembership|null{
  return readAll()[userId]??null;
}
function readAll():Record<string,CachedOfflineMembership>{
  const s=storage(); if(!s)return {};
  try{
    const parsed=JSON.parse(s.getItem(KEY)??'{}') as unknown;
    if(!parsed||typeof parsed!=='object'||Array.isArray(parsed))return {};
    return parsed as Record<string,CachedOfflineMembership>;
  }catch{return {};}
}
