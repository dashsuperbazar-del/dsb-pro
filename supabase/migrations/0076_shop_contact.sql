-- shopcontact: shop phone number and receipt footer (old DSB shop settings), printed on receipts and shares.
--  * shops.phone: digits, spaces, +, -, ( ) only, at most 20 characters. Display data, never used to log in.
--  * shops.receipt_footer: free text at most 200 characters (for example "Thank you, visit again").
--  * update_shop_contact(shop, phone, footer): owner/manager only, tenant from the JWT (phase3_assert_shop);
--    blank input clears the value. update_shop_settings is unchanged. updated_at stays server-set by the
--    existing shops trigger.
-- No money, stock or ledger effect. Existing rows get NULL (nothing printed). Forward-only.

alter table shops add column phone text
  check (phone is null or (char_length(phone) between 1 and 20 and phone ~ '^[0-9+() -]+$'));
alter table shops add column receipt_footer text
  check (receipt_footer is null or char_length(receipt_footer) between 1 and 200);

create function update_shop_contact(p_shop_id uuid, p_phone text, p_footer text)
returns void language plpgsql security definer set search_path=public as $$
declare v_tenant uuid; v_role text:="current_role"();
 v_phone text:=nullif(btrim(coalesce(p_phone,'')),''); v_footer text:=nullif(btrim(coalesce(p_footer,'')),'');
begin
  v_tenant:=phase3_assert_shop(p_shop_id);
  if v_role is null or v_role not in ('owner','manager') then raise exception 'not permitted'; end if;
  if v_phone is not null and (char_length(v_phone)>20 or v_phone !~ '^[0-9+() -]+$') then
    raise exception 'DSB_INVALID_PHONE: use digits, spaces, + - ( ) only, at most 20 characters';
  end if;
  if v_footer is not null and char_length(v_footer)>200 then
    raise exception 'DSB_FOOTER_TOO_LONG: the receipt footer can be at most 200 characters';
  end if;
  update shops set phone=v_phone, receipt_footer=v_footer
   where id=p_shop_id and tenant_id=v_tenant and deleted_at is null;
  if not found then raise exception 'shop not found'; end if;
end $$;
revoke all on function update_shop_contact(uuid,text,text) from public,anon;
grant execute on function update_shop_contact(uuid,text,text) to authenticated;
