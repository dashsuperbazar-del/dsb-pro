-- Phase 6.5 (plan §19.1): shop profile settings that were database-only.
-- `shops.name`, `.address`, `.invoice_prefix` and `.timezone` already existed
-- with no update path except direct SQL. GSTIN, printer width and fiscal
-- year start month did not exist at all. This adds the missing columns and
-- one owner/manager-only RPC to change any of them; there is still no client
-- UPDATE policy on `shops`, matching every other table in this schema.

alter table shops add column if not exists gstin text;
alter table shops add column if not exists printer_width text not null default '80mm';
alter table shops add constraint shops_printer_width_check check (printer_width in ('58mm','80mm'));
alter table shops add column if not exists fiscal_year_start_month smallint not null default 4;
alter table shops add constraint shops_fiscal_year_start_month_check check (fiscal_year_start_month between 1 and 12);

create function update_shop_settings(
  p_shop_id uuid, p_name text, p_address text, p_gstin text, p_invoice_prefix text,
  p_timezone text, p_printer_width text, p_fiscal_year_start_month smallint
) returns void language plpgsql security definer set search_path=public as $$
declare v_tenant uuid;
begin
  v_tenant:=phase3_assert_shop(p_shop_id);
  if "current_role"() not in ('owner','manager') then raise exception 'not permitted'; end if;
  if p_name is null or btrim(p_name)='' then raise exception 'shop name required'; end if;
  if p_timezone is null or btrim(p_timezone)='' then raise exception 'timezone required'; end if;
  if p_printer_width is null or p_printer_width not in ('58mm','80mm') then raise exception 'invalid printer width'; end if;
  if p_fiscal_year_start_month is null or p_fiscal_year_start_month<1 or p_fiscal_year_start_month>12
    then raise exception 'invalid fiscal year start month'; end if;
  update shops set
    name=btrim(p_name),
    address=nullif(btrim(coalesce(p_address,'')),''),
    gstin=nullif(btrim(coalesce(p_gstin,'')),''),
    invoice_prefix=nullif(btrim(coalesce(p_invoice_prefix,'')),''),
    timezone=btrim(p_timezone),
    printer_width=p_printer_width,
    fiscal_year_start_month=p_fiscal_year_start_month
  where id=p_shop_id and tenant_id=v_tenant and deleted_at is null;
  if not found then raise exception 'shop not found'; end if;
end $$;
revoke all on function update_shop_settings(uuid,text,text,text,text,text,text,smallint) from public,anon;
grant execute on function update_shop_settings(uuid,text,text,text,text,text,text,smallint) to authenticated;
