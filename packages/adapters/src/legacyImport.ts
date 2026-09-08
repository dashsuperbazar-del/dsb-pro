import type { LegacyDsbImportPlan } from '@dsb-pro/core';
import { getSupabaseClient } from './client';
import { classifyError, errorMessage } from './errors';

export type LegacyDsbImportSummary = {
  sourceVersion:number;
  exportedAt:string;
  items:number;
  parties:number;
  customers:number;
  prices:number;
  stockRows:number;
};

export async function importLegacyDsbMaster(input:{
  shopId:string;
  plan:LegacyDsbImportPlan;
  clientId:string;
}):Promise<LegacyDsbImportSummary>{
  const {data,error}=await getSupabaseClient().rpc('import_legacy_dsb_master',{
    p_shop_id:input.shopId,
    p_plan:input.plan,
    p_client_id:input.clientId,
  });
  if(error) throw new Error(errorMessage(classifyError(error),error));
  if(!data || typeof data!=='object') throw new Error('Legacy import summary was not returned.');
  return data as LegacyDsbImportSummary;
}
