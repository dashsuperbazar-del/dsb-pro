import { useEffect, useMemo, useState } from 'preact/hooks';
import {
  addItemBarcode, createItem, createParty, getCurrentMembership, getDefaultShopId, getShopBusinessDate, listCurrentPrices,
  listItems, listParties, listStock, postPurchase, replaceItemImage, setItemPrice,
  type Item, type ItemPrice, type Party, type StockRow,
} from '@dsb-pro/adapters';
import { compressItemImage } from '../lib/compressImage';
import { appRoute } from '../lib/paths';

const paise = (rupees:string) => Math.round(Number(rupees || '0') * 100);

export function InventoryScreen() {
  const [items,setItems]=useState<Item[]>([]); const [parties,setParties]=useState<Party[]>([]); const [stock,setStock]=useState<StockRow[]>([]);
  const [shopId,setShopId]=useState(''); const [tenantId,setTenantId]=useState(''); const [businessDate,setBusinessDate]=useState(''); const [selected,setSelected]=useState(''); const [purchaseItemId,setPurchaseItemId]=useState(''); const [prices,setPrices]=useState<ItemPrice[]>([]);
  const [message,setMessage]=useState(''); const [error,setError]=useState('');
  async function refresh(){
    const membership=await getCurrentMembership(); if(!membership) throw new Error('No tenant membership.');
    const shop=await getDefaultShopId(); setTenantId(membership.tenantId); setShopId(shop);
    const [i,p,s,d]=await Promise.all([listItems(),listParties(),listStock(shop),getShopBusinessDate(shop)]); setItems(i); setParties(p); setStock(s); setBusinessDate(d);
  }
  useEffect(()=>{ void refresh().catch(e=>setError(String(e))); },[]);
  useEffect(()=>{ if(!selected){setPrices([]);return;} void listCurrentPrices(selected).then(setPrices).catch(e=>setError(String(e))); },[selected]);
  const selectedItem=items.find(i=>i.id===selected); const purchaseItem=items.find(i=>i.id===purchaseItemId);
  const selectedStock=useMemo(()=>stock.find(s=>s.item_id===selected)?.qty_base??0,[stock,selected]);

  async function addItem(ev:Event){ ev.preventDefault(); setError(''); if(!tenantId){setError('Shop data is still loading.');return;} const form=ev.currentTarget as HTMLFormElement; const f=new FormData(form);
    try { const item=await createItem({tenantId,name:String(f.get('name')),sku:String(f.get('sku')||'')||undefined,unit1:String(f.get('unit1')),unit2:String(f.get('unit2')||'')||undefined,unit3:String(f.get('unit3')||'')||undefined,conv1:f.get('conv1')?Number(f.get('conv1')):undefined,conv2:f.get('conv2')?Number(f.get('conv2')):undefined,clientId:crypto.randomUUID()}); form.reset(); await refresh(); setMessage(`Created ${item.name}.`); } catch(e){setError(String(e));}
  }
  async function addBarcode(ev:Event){ ev.preventDefault(); if(!tenantId){setError('Shop data is still loading.');return;} if(!selectedItem)return; const form=ev.currentTarget as HTMLFormElement; const f=new FormData(form);
    try { await addItemBarcode({tenantId,itemId:selectedItem.id,barcode:String(f.get('barcode')),unitLevel:Number(f.get('unitLevel')) as 1|2|3,clientId:crypto.randomUUID()}); form.reset(); setMessage('Barcode linked to item.'); } catch(e){setError(String(e));}
  }
  async function addParty(ev:Event){ ev.preventDefault(); setError(''); if(!tenantId){setError('Shop data is still loading.');return;} const form=ev.currentTarget as HTMLFormElement; const f=new FormData(form);
    try { const party=await createParty({tenantId,name:String(f.get('name')),phone:String(f.get('phone')||'')||undefined,gstin:String(f.get('gstin')||'')||undefined,clientId:crypto.randomUUID()}); form.reset(); await refresh(); setMessage(`Created supplier ${party.name}.`); } catch(e){setError(String(e));}
  }
  async function addPurchase(ev:Event){ ev.preventDefault(); setError(''); if(!shopId||!businessDate){setError('Shop data is still loading.');return;} const f=new FormData(ev.currentTarget as HTMLFormElement); const itemId=String(f.get('itemId')); const item=items.find(i=>i.id===itemId); if(!item){setError('Choose an item.');return;}
    try { await postPurchase({shopId,partyId:String(f.get('partyId')||'')||undefined,billNo:String(f.get('billNo')||'')||undefined,businessDate:String(f.get('date')),discountPaise:paise(String(f.get('discount'))),extraChargesPaise:paise(String(f.get('extra'))),clientId:crypto.randomUUID(),lines:[{itemId,unitLevel:Number(f.get('unitLevel')) as 1|2|3,qty:Number(f.get('qty')),unitPricePaise:paise(String(f.get('price')))}]}); await refresh(); setMessage('Purchase posted and stock updated.'); } catch(e){setError(String(e));}
  }
  async function changePrice(ev:Event){ ev.preventDefault(); if(!shopId){setError('Shop data is still loading.');return;} if(!selected)return; const f=new FormData(ev.currentTarget as HTMLFormElement);
    try { await setItemPrice({itemId:selected,shopId,kind:String(f.get('kind')) as ItemPrice['kind'],unitLevel:Number(f.get('unitLevel')) as 1|2|3,pricePaise:paise(String(f.get('price'))),clientId:crypto.randomUUID()}); setPrices(await listCurrentPrices(selected)); setMessage('Price history updated atomically.'); } catch(e){setError(String(e));}
  }
  async function changeImage(ev:Event){ const file=(ev.currentTarget as HTMLInputElement).files?.[0]; if(!file||!selectedItem)return; try { const blob=await compressItemImage(file); const path=await replaceItemImage({tenantId,itemId:selectedItem.id,blob,oldPath:selectedItem.image_path}); setMessage(`Image stored (${Math.round(blob.size/1024)} KB).`); setItems(v=>v.map(i=>i.id===selectedItem.id?{...i,image_path:path}:i)); } catch(e){setError(String(e));} }

  return <main>
    <p><a href={appRoute.home}>← Home</a></p><h1>Inventory & purchases</h1>
    {error&&<p role="alert">{error}</p>}{message&&<p role="status">{message}</p>}
    <section><h2>Item master</h2><p>Unit order follows DSB: big → small → piece. Stock is stored in the smallest configured unit.</p><form onSubmit={addItem}><input name="name" placeholder="Item name" required/> <input name="sku" placeholder="SKU"/> <input name="unit1" placeholder="Big unit (e.g. case)" required/> <input name="unit2" placeholder="Small unit (e.g. pack)"/> <input name="conv1" type="number" min="0" step="any" placeholder="Small units per big"/> <input name="unit3" placeholder="Piece unit (optional)"/> <input name="conv2" type="number" min="0" step="any" placeholder="Pieces per small"/> <button disabled={!tenantId}>Create item</button></form>
      <label>Peek item <select value={selected} onChange={e=>setSelected((e.currentTarget as HTMLSelectElement).value)}><option value="">Choose…</option>{items.map(i=><option value={i.id}>{i.name}</option>)}</select></label>
      {selectedItem&&<div aria-label="item peek"><strong>{selectedItem.name}</strong> · Stock {selectedStock} {selectedItem.unit3||selectedItem.unit2||selectedItem.unit1}<br/>Current prices: {prices.length?prices.map(p=>`${p.kind} ₹${(p.price_paise/100).toFixed(2)}`).join(' · '):'none'}<br/><input type="file" accept="image/*" onChange={changeImage}/></div>}
      {selectedItem&&<form onSubmit={addBarcode}><input name="barcode" placeholder="Barcode" required/> <select name="unitLevel"><option value="1">{selectedItem.unit1}</option>{selectedItem.unit2&&<option value="2">{selectedItem.unit2}</option>}{selectedItem.unit3&&<option value="3">{selectedItem.unit3}</option>}</select> <button disabled={!tenantId}>Link barcode</button></form>}
      {selectedItem&&<form onSubmit={changePrice}><select name="kind"><option value="retail">Retail</option><option value="wholesale">Wholesale</option><option value="mrp">MRP</option><option value="cost_last">Last cost</option></select> <select name="unitLevel"><option value="1">{selectedItem.unit1}</option>{selectedItem.unit2&&<option value="2">{selectedItem.unit2}</option>}{selectedItem.unit3&&<option value="3">{selectedItem.unit3}</option>}</select> <input name="price" type="number" min="0" step="0.01" placeholder="₹ price" required/> <button disabled={!shopId}>Set price</button></form>}
    </section>
    <section><h2>Suppliers</h2><form onSubmit={addParty}><input name="name" placeholder="Supplier name" required/> <input name="phone" placeholder="Phone"/> <input name="gstin" placeholder="GSTIN"/> <button disabled={!tenantId}>Create supplier</button></form></section>
    <section><h2>Post purchase</h2><form onSubmit={addPurchase}><input name="billNo" placeholder="Bill no."/> <input name="date" type="date" value={businessDate} onInput={e=>setBusinessDate((e.currentTarget as HTMLInputElement).value)} required/> <select name="partyId"><option value="">No supplier</option>{parties.map(p=><option value={p.id}>{p.name}</option>)}</select> <select name="itemId" required value={purchaseItemId} onChange={e=>setPurchaseItemId((e.currentTarget as HTMLSelectElement).value)}><option value="">Item…</option>{items.map(i=><option value={i.id}>{i.name}</option>)}</select> <select name="unitLevel" required disabled={!purchaseItem}><option value="1">{purchaseItem?.unit1||'Big unit'}</option>{purchaseItem?.unit2&&<option value="2">{purchaseItem.unit2}</option>}{purchaseItem?.unit3&&<option value="3">{purchaseItem.unit3}</option>}</select> <input name="qty" type="number" min="0.000001" step="any" placeholder="Qty" required/> <input name="price" type="number" min="0" step="0.01" placeholder="Unit cost ₹" required/> <input name="discount" type="number" min="0" step="0.01" placeholder="Discount ₹"/> <input name="extra" type="number" min="0" step="0.01" placeholder="Extra ₹"/> <button disabled={!shopId||!businessDate}>Post purchase</button></form></section>
  </main>;
}
