-- Packet D2b (group d2b): server-side guards on shop settings (plan v1.1 §10). Same nine-argument
-- signature (callers unchanged). The shop row is locked before policy fields are compared, so an
-- owner's and a manager's racing saves cannot override each other's checks. The timezone must be a
-- known IANA name when it changes. Only the owner changes allow_negative_stock. The fiscal-year start month stays
-- frozen until F1 supplies guarded fiscal numbering.
create or replace function update_shop_settings(
  p_shop_id uuid, p_name text, p_address text, p_gstin text, p_invoice_prefix text,
  p_timezone text, p_printer_width text, p_fiscal_year_start_month smallint, p_allow_negative_stock boolean
) returns void language plpgsql security definer set search_path=public as $$
declare v_tenant uuid; v_role text:="current_role"(); v_shop shops%rowtype; v_tz text:=btrim(coalesce(p_timezone,''));
begin
  v_tenant:=phase3_assert_shop(p_shop_id);
  if v_role is null or v_role not in ('owner','manager') then raise exception 'not permitted'; end if;
  if p_name is null or btrim(p_name)='' then raise exception 'shop name required'; end if;
  if v_tz='' then raise exception 'timezone required'; end if;
  if p_printer_width is null or p_printer_width not in ('58mm','80mm') then raise exception 'invalid printer width'; end if;
  if p_fiscal_year_start_month is null or p_fiscal_year_start_month<1 or p_fiscal_year_start_month>12
    then raise exception 'invalid fiscal year start month'; end if;
  if p_allow_negative_stock is null then raise exception 'allow_negative_stock required'; end if;
  select * into v_shop from shops where id=p_shop_id and tenant_id=v_tenant and deleted_at is null for update;
  if not found then raise exception 'shop not found'; end if;
  -- Checked only when it changes, so a shop holding an older free-text timezone can still save.
  if v_tz<>v_shop.timezone and not exists(select 1 from pg_timezone_names where name=v_tz) then
    raise exception 'DSB_INVALID_TIMEZONE: unknown timezone %', v_tz;
  end if;
  if p_allow_negative_stock<>v_shop.allow_negative_stock and v_role<>'owner' then
    raise exception 'DSB_OWNER_ONLY: only the owner can change the negative-stock policy';
  end if;
  if p_fiscal_year_start_month<>v_shop.fiscal_year_start_month then
    raise exception 'DSB_FISCAL_MONTH_FROZEN: the fiscal year start month cannot be changed yet';
  end if;
  update shops set
    name=btrim(p_name),
    address=nullif(btrim(coalesce(p_address,'')),''),
    gstin=nullif(btrim(coalesce(p_gstin,'')),''),
    invoice_prefix=nullif(btrim(coalesce(p_invoice_prefix,'')),''),
    timezone=v_tz,
    printer_width=p_printer_width,
    fiscal_year_start_month=p_fiscal_year_start_month,
    allow_negative_stock=p_allow_negative_stock
  where id=v_shop.id;
end $$;
