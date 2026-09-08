-- Phase 4 trigger hardening.
-- Return NEW/OLD explicitly from the deferred allocation sum trigger rather than
-- relying on record coalesce semantics across INSERT/UPDATE/DELETE operations.
create or replace function phase4_check_payment_sum() returns trigger
language plpgsql security definer set search_path=public as $$
declare
  v_payment uuid;
  v_amount bigint;
  v_sum bigint;
begin
  if tg_op='DELETE' then
    v_payment:=old.payment_id;
  else
    v_payment:=new.payment_id;
  end if;

  select amount_paise into v_amount from payments where id=v_payment;
  if v_amount is null then raise exception 'payment unavailable'; end if;

  select coalesce(sum(amount_paise),0) into v_sum
  from payment_allocations
  where payment_id=v_payment and status='POSTED';

  if v_sum>v_amount then raise exception 'payment allocations exceed payment amount'; end if;

  if tg_op='DELETE' then return old; end if;
  return new;
end $$;
