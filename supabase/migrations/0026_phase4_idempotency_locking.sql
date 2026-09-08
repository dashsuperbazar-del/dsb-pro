-- Phase 4 idempotency hardening.
-- Serialize simultaneous retries with the same (tenant, client_id) before any
-- stock/payment validation. This makes an unknown-outcome retry converge on the
-- first financial row instead of racing it.

alter function post_sale(uuid,uuid,date,bigint,bigint,text,jsonb,jsonb,text)
rename to phase4_post_sale_unlocked;
revoke all on function phase4_post_sale_unlocked(uuid,uuid,date,bigint,bigint,text,jsonb,jsonb,text) from public;
revoke all on function phase4_post_sale_unlocked(uuid,uuid,date,bigint,bigint,text,jsonb,jsonb,text) from authenticated;

create function post_sale(
  p_shop_id uuid,p_customer_id uuid,p_business_date date,p_discount_paise bigint,p_extra_charges_paise bigint,
  p_client_id text,p_lines jsonb,p_payments jsonb default '[]'::jsonb,p_notes text default null
) returns uuid
language plpgsql security definer set search_path=public as $$
declare v_tenant uuid;
begin
  if p_client_id is null or btrim(p_client_id)='' then raise exception 'client_id required'; end if;
  v_tenant:=phase3_assert_shop(p_shop_id);
  perform pg_advisory_xact_lock(hashtextextended(v_tenant::text||':sale:'||p_client_id,0));
  return phase4_post_sale_unlocked(p_shop_id,p_customer_id,p_business_date,p_discount_paise,p_extra_charges_paise,p_client_id,p_lines,p_payments,p_notes);
end $$;
revoke all on function post_sale(uuid,uuid,date,bigint,bigint,text,jsonb,jsonb,text) from public;
grant execute on function post_sale(uuid,uuid,date,bigint,bigint,text,jsonb,jsonb,text) to authenticated;

alter function record_customer_payment(uuid,uuid,date,bigint,text,text,jsonb,text)
rename to phase4_record_customer_payment_unlocked;
revoke all on function phase4_record_customer_payment_unlocked(uuid,uuid,date,bigint,text,text,jsonb,text) from public;
revoke all on function phase4_record_customer_payment_unlocked(uuid,uuid,date,bigint,text,text,jsonb,text) from authenticated;

create function record_customer_payment(
  p_shop_id uuid,p_customer_id uuid,p_business_date date,p_amount_paise bigint,p_mode text,p_reference text,
  p_allocations jsonb,p_client_id text
) returns uuid
language plpgsql security definer set search_path=public as $$
declare v_tenant uuid;
begin
  if p_client_id is null or btrim(p_client_id)='' then raise exception 'client_id required'; end if;
  v_tenant:=phase3_assert_shop(p_shop_id);
  perform pg_advisory_xact_lock(hashtextextended(v_tenant::text||':customer-payment:'||p_client_id,0));
  return phase4_record_customer_payment_unlocked(p_shop_id,p_customer_id,p_business_date,p_amount_paise,p_mode,p_reference,p_allocations,p_client_id);
end $$;
revoke all on function record_customer_payment(uuid,uuid,date,bigint,text,text,jsonb,text) from public;
grant execute on function record_customer_payment(uuid,uuid,date,bigint,text,text,jsonb,text) to authenticated;
