import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import {
  addItemBarcode, createItem, createParty, getCurrentMembership, getDefaultShopId, getShopBusinessDate, importLegacyDsbMaster, listCurrentPrices,
  listItems, listParties, listStock, postPurchase, replaceItemImage, setItemPrice, setItemMinStock,
  type Item, type ItemPrice, type Party, type StockRow,
} from '@dsb-pro/adapters';
import { buildLegacyDsbImportPlan, type LegacyDsbImportPlan } from '@dsb-pro/core';
import { compressItemImage } from '../lib/compressImage';
import { appRoute } from '../lib/paths';

const paise = (rupees:string) => Math.round(Number(rupees || '0') * 100);

export function InventoryScreen() {
  const [items,setItems]=useState<Item[]>([]); const [parties,setParties]=useState<Party[]>([]); const [stock,setStock]=useState<StockRow[]>([]);
  const [shopId,setShopId]=useState(''); const [tenantId,setTenantId]=useState(''); const [businessDate,setBusinessDate]=useState(''); const [selected,setSelected]=useState(''); const [purchaseLineItemId,setPurchaseLineItemId]=useState(''); const [prices,setPrices]=useState<ItemPrice[]>([]);
  const [purchaseLineUnitLevel,setPurchaseLineUnitLevel]=useState<1|2|3>(1); const [purchaseLineQty,setPurchaseLineQty]=useState(''); const [purchaseLinePrice,setPurchaseLinePrice]=useState('');
  const [purchaseCart,setPurchaseCart]=useState<{item:Item;unitLevel:1|2|3;qty:number;unitPricePaise:number}[]>([]);
  const [purchaseClientId,setPurchaseClientId]=useState(()=>crypto.randomUUID()); const [purchaseBusy,setPurchaseBusy]=useState(false);
  const [legacyPlan,setLegacyPlan]=useState<LegacyDsbImportPlan|null>(null); const [legacyFileName,setLegacyFileName]=useState(''); const [legacyClientId,setLegacyClientId]=useState(()=>crypto.randomUUID()); const [legacyBusy,setLegacyBusy]=useState(false);
  const [message,setMessage]=useState(''); const [error,setError]=useState('');
  const refreshGeneration=useRef(0);
  async function refresh(){
    const generation=++refreshGeneration.current;
    const membership=await getCurrentMembership(); if(!membership) throw new Error('No tenant membership.');
    const shop=await getDefaultShopId();if(generation!==refreshGeneration.current)return;setTenantId(membership.tenantId);setShopId(shop);
    const [i,p,s,d]=await Promise.all([listItems(),listParties(),listStock(shop),getShopBusinessDate(shop)]);
    if(generation!==refreshGeneration.current)return;
    setItems(i);setParties(p);setStock(s);setBusinessDate(d);
  }
  useEffect(()=>{ void refresh().catch(e=>setError(String(e)));return()=>{refreshGeneration.current++;}; },[]);
  useEffect(()=>{ if(!selected){setPrices([]);return;} void listCurrentPrices(selected).then(setPrices).catch(e=>setError(String(e))); },[selected]);
  const selectedItem=items.find(i=>i.id===selected); const purchaseLineItem=items.find(i=>i.id===purchaseLineItemId);
  const selectedStock=useMemo(()=>stock.find(s=>s.item_id===selected)?.qty_base??0,[stock,selected]);
  const purchaseTotalPaise=useMemo(()=>purchaseCart.reduce((sum,l)=>sum+Math.round(l.qty*l.unitPricePaise),0),[purchaseCart]);
  const unitLabel=(item:Item,unitLevel:1|2|3)=>unitLevel===1?item.unit1:unitLevel===2?(item.unit2||item.unit1):(item.unit3||item.unit2||item.unit1);

  async function chooseLegacyBackup(ev:Event){
    setError(''); setMessage(''); setLegacyPlan(null); setLegacyFileName('');
    const file=(ev.currentTarget as HTMLInputElement).files?.[0]; if(!file)return;
    if(file.size>5*1024*1024){setError('DSB backup is too large to import from this screen.');return;}
    try{
      const parsed=JSON.parse(await file.text()) as unknown;
      const plan=buildLegacyDsbImportPlan(parsed);
      setLegacyPlan(plan); setLegacyFileName(file.name);
      setMessage(`Backup checked: ${plan.items.length} valid items are ready to import.`);
    }catch(e){setError(e instanceof Error?e.message:String(e));}
  }
  async function runLegacyImport(){
    if(legacyBusy||!legacyPlan||!shopId)return;
    const ok=window.confirm(`Import ${legacyPlan.items.length} items and their current stock into this empty DSB Pro shop? Old bills and invoices will NOT be imported.`);
    if(!ok)return;
    setLegacyBusy(true); setError(''); setMessage('');
    try{
      const summary=await importLegacyDsbMaster({shopId,plan:legacyPlan,clientId:legacyClientId});
      setLegacyClientId(crypto.randomUUID());
      await refresh();
      setLegacyPlan(null); setLegacyFileName('');
      setMessage(`Import complete: ${summary.items} items, ${summary.parties} suppliers, ${summary.customers} customers and ${summary.stockRows} stock balances loaded.`);
    }catch(e){setError(e instanceof Error?e.message:String(e));}
    finally{setLegacyBusy(false);}
  }
  async function addItem(ev:Event){ ev.preventDefault(); setError(''); if(!tenantId){setError('Shop data is still loading.');return;} const form=ev.currentTarget as HTMLFormElement; const f=new FormData(form);
    try { const item=await createItem({tenantId,name:String(f.get('name')),sku:String(f.get('sku')||'')||undefined,unit1:String(f.get('unit1')),unit2:String(f.get('unit2')||'')||undefined,unit3:String(f.get('unit3')||'')||undefined,conv1:f.get('conv1')?Number(f.get('conv1')):undefined,conv2:f.get('conv2')?Number(f.get('conv2')):undefined,clientId:crypto.randomUUID()}); form.reset(); await refresh(); setMessage(`Created ${item.name}.`); } catch(e){setError(String(e));}
  }
  async function addBarcode(ev:Event){ ev.preventDefault(); if(!tenantId){setError('Shop data is still loading.');return;} if(!selectedItem)return; const form=ev.currentTarget as HTMLFormElement; const f=new FormData(form);
    try { await addItemBarcode({tenantId,itemId:selectedItem.id,barcode:String(f.get('barcode')),unitLevel:Number(f.get('unitLevel')) as 1|2|3,clientId:crypto.randomUUID()}); form.reset(); setMessage('Barcode linked to item.'); } catch(e){setError(String(e));}
  }
  async function addParty(ev:Event){ ev.preventDefault(); setError(''); if(!tenantId){setError('Shop data is still loading.');return;} const form=ev.currentTarget as HTMLFormElement; const f=new FormData(form);
    try { const party=await createParty({tenantId,name:String(f.get('name')),phone:String(f.get('phone')||'')||undefined,gstin:String(f.get('gstin')||'')||undefined,clientId:crypto.randomUUID()}); form.reset(); await refresh(); setMessage(`Created supplier ${party.name}.`); } catch(e){setError(String(e));}
  }
  function addPurchaseLine(ev:Event){ ev.preventDefault(); setError('');
    const item=items.find(i=>i.id===purchaseLineItemId); const qty=Number(purchaseLineQty); const unitPricePaise=paise(purchaseLinePrice);
    if(!item){setError('Choose an item for the purchase line.');return;}
    if(!(qty>0)){setError('Enter a purchase quantity greater than zero.');return;}
    if(!purchaseLinePrice.trim()||!(unitPricePaise>=0)){setError('Enter a unit cost.');return;}
    setPurchaseCart(v=>[...v,{item,unitLevel:purchaseLineUnitLevel,qty,unitPricePaise}]);
    setPurchaseLineItemId(''); setPurchaseLineUnitLevel(1); setPurchaseLineQty(''); setPurchaseLinePrice('');
  }
  function removePurchaseLine(index:number){ setPurchaseCart(v=>v.filter((_,i)=>i!==index)); }
  async function addPurchase(ev:Event){ ev.preventDefault(); if(purchaseBusy)return; setError('');
    if(!shopId||!businessDate){setError('Shop data is still loading.');return;}
    if(!purchaseCart.length){setError('Add at least one purchase line.');return;}
    const f=new FormData(ev.currentTarget as HTMLFormElement); const lineCount=purchaseCart.length; setPurchaseBusy(true);
    try {
      await postPurchase({shopId,partyId:String(f.get('partyId')||'')||undefined,billNo:String(f.get('billNo')||'')||undefined,businessDate:String(f.get('date')),discountPaise:paise(String(f.get('discount'))),extraChargesPaise:paise(String(f.get('extra'))),clientId:purchaseClientId,
        lines:purchaseCart.map(l=>({itemId:l.item.id,unitLevel:l.unitLevel,qty:l.qty,unitPricePaise:l.unitPricePaise}))});
      setPurchaseClientId(crypto.randomUUID()); setPurchaseCart([]); await refresh();
      setMessage(`Purchase posted (${lineCount} line${lineCount===1?'':'s'}) and stock updated.`);
    } catch(e){setError(String(e));} finally{setPurchaseBusy(false);}
  }
  async function changePrice(ev:Event){ ev.preventDefault(); if(!shopId){setError('Shop data is still loading.');return;} if(!selected)return; const f=new FormData(ev.currentTarget as HTMLFormElement);
    try { await setItemPrice({itemId:selected,shopId,kind:String(f.get('kind')) as ItemPrice['kind'],unitLevel:Number(f.get('unitLevel')) as 1|2|3,pricePaise:paise(String(f.get('price'))),clientId:crypto.randomUUID()}); setPrices(await listCurrentPrices(selected)); setMessage('Price history updated atomically.'); } catch(e){setError(String(e));}
  }
  async function changeImage(ev:Event){ const file=(ev.currentTarget as HTMLInputElement).files?.[0]; if(!file||!selectedItem)return; try { const blob=await compressItemImage(file); const path=await replaceItemImage({tenantId,itemId:selectedItem.id,blob,oldPath:selectedItem.image_path}); setMessage(`Image stored (${Math.round(blob.size/1024)} KB).`); setItems(v=>v.map(i=>i.id===selectedItem.id?{...i,image_path:path}:i)); } catch(e){setError(String(e));} }
  async function changeMinStock(ev:Event){ ev.preventDefault(); if(!selectedItem)return; const f=new FormData(ev.currentTarget as HTMLFormElement);
    try { const updated=await setItemMinStock(selectedItem.id,Number(f.get('minStock'))); setItems(v=>v.map(i=>i.id===updated.id?updated:i)); setMessage('Reorder threshold saved.'); } catch(e){setError(String(e));}
  }

  return <main>
    <p><a href={appRoute.home}>← Home</a></p><h1>Inventory & purchases</h1>
    {error&&<p role="alert">{error}</p>}{message&&<p role="status">{message}</p>}
    <section aria-label="Import old DSB backup"><h2>Import old DSB backup</h2>
      <p class="muted">Shop-test setup only. This imports the current item master, sale prices, current stock, suppliers and real customers. It does not copy historical purchase bills, sales invoices or payments.</p>
      <input aria-label="Choose DSB backup JSON" type="file" accept=".json,application/json" onChange={chooseLegacyBackup}/>
      {legacyPlan&&<div class="card"><strong>{legacyFileName}</strong><br/>Ready: {legacyPlan.items.length} items · {legacyPlan.parties.length} suppliers · {legacyPlan.customers.length} customers · {legacyPlan.items.reduce((n,i)=>n+i.prices.length,0)} price rows · {legacyPlan.items.filter(i=>i.openingStockSmallest>0).length} positive stock balances.
        {legacyPlan.warnings.length>0&&<><p><strong>{legacyPlan.warnings.length} warnings</strong> (nothing is silently guessed):</p><ul>{legacyPlan.warnings.slice(0,6).map((w,n)=><li key={n}>{w}</li>)}</ul>{legacyPlan.warnings.length>6&&<p>…and {legacyPlan.warnings.length-6} more. Items without a usable sale price remain unsellable until a price is added.</p>}</>}
        <p><button type="button" class="primary" disabled={legacyBusy||!shopId} onClick={()=>void runLegacyImport()}>{legacyBusy?'Importing…':'Import checked backup'}</button></p>
      </div>}
    </section>
    <section><h2>Item master</h2><p>Unit order follows DSB: big → small → piece. Stock is stored in the smallest configured unit.</p><form onSubmit={addItem}><input name="name" placeholder="Item name" required/> <input name="sku" placeholder="SKU"/> <input name="unit1" placeholder="Big unit (e.g. case)" required/> <input name="unit2" placeholder="Small unit (e.g. pack)"/> <input name="conv1" type="number" min="0" step="any" placeholder="Small units per big"/> <input name="unit3" placeholder="Piece unit (optional)"/> <input name="conv2" type="number" min="0" step="any" placeholder="Pieces per small"/> <button disabled={!tenantId}>Create item</button></form>
      <label>Peek item <select value={selected} onChange={e=>setSelected((e.currentTarget as HTMLSelectElement).value)}><option value="">Choose…</option>{items.map(i=><option key={i.id} value={i.id}>{i.name}</option>)}</select></label>
      {selectedItem&&<div aria-label="item peek"><strong>{selectedItem.name}</strong> · Stock {selectedStock} {selectedItem.unit3||selectedItem.unit2||selectedItem.unit1}<br/>Current prices: {prices.length?prices.map(p=>`${p.kind} ₹${(p.price_paise/100).toFixed(2)}`).join(' · '):'none'}<br/>Reorder at: {selectedItem.min_stock} {selectedItem.unit3||selectedItem.unit2||selectedItem.unit1}<br/><input type="file" accept="image/*" onChange={changeImage}/></div>}
      {selectedItem&&<form onSubmit={changeMinStock}><label>Reorder threshold ({selectedItem.unit3||selectedItem.unit2||selectedItem.unit1}) <input name="minStock" type="number" min="0" step="any" defaultValue={selectedItem.min_stock} key={selectedItem.id}/></label> <button disabled={!shopId}>Save reorder threshold</button></form>}
      {selectedItem&&<form onSubmit={addBarcode}><input name="barcode" placeholder="Barcode" required/> <select name="unitLevel"><option value="1">{selectedItem.unit1}</option>{selectedItem.unit2&&<option value="2">{selectedItem.unit2}</option>}{selectedItem.unit3&&<option value="3">{selectedItem.unit3}</option>}</select> <button disabled={!tenantId}>Link barcode</button></form>}
      {selectedItem&&<form onSubmit={changePrice}><select name="kind"><option value="retail">Retail</option><option value="wholesale">Wholesale</option><option value="mrp">MRP</option><option value="cost_last">Last cost</option></select> <select name="unitLevel"><option value="1">{selectedItem.unit1}</option>{selectedItem.unit2&&<option value="2">{selectedItem.unit2}</option>}{selectedItem.unit3&&<option value="3">{selectedItem.unit3}</option>}</select> <input name="price" type="number" min="0" step="0.01" placeholder="₹ price" required/> <button disabled={!shopId}>Set price</button></form>}
    </section>
    <section><h2>Suppliers</h2><form onSubmit={addParty}><input name="name" placeholder="Supplier name" required/> <input name="phone" placeholder="Phone"/> <input name="gstin" placeholder="GSTIN"/> <button disabled={!tenantId}>Create supplier</button></form></section>
    <section><h2>Post purchase</h2><form onSubmit={addPurchase}>
      <input name="billNo" placeholder="Bill no."/> <input name="date" type="date" value={businessDate} onInput={e=>setBusinessDate((e.currentTarget as HTMLInputElement).value)} required/> <select name="partyId"><option value="">No supplier</option>{parties.map(p=><option key={p.id} value={p.id}>{p.name}</option>)}</select> <input name="discount" type="number" min="0" step="0.01" placeholder="Discount ₹"/> <input name="extra" type="number" min="0" step="0.01" placeholder="Extra ₹"/>
      <fieldset><legend>Add purchase line</legend>
        <select name="itemId" value={purchaseLineItemId} onChange={e=>{setPurchaseLineItemId((e.currentTarget as HTMLSelectElement).value);setPurchaseLineUnitLevel(1);}}><option value="">Item…</option>{items.map(i=><option key={i.id} value={i.id}>{i.name}</option>)}</select> <select name="unitLevel" disabled={!purchaseLineItem} value={purchaseLineUnitLevel} onChange={e=>setPurchaseLineUnitLevel(Number((e.currentTarget as HTMLSelectElement).value) as 1|2|3)}><option value="1">{purchaseLineItem?.unit1||'Big unit'}</option>{purchaseLineItem?.unit2&&<option value="2">{purchaseLineItem.unit2}</option>}{purchaseLineItem?.unit3&&<option value="3">{purchaseLineItem.unit3}</option>}</select> <input name="qty" type="number" min="0.000001" step="any" placeholder="Qty" value={purchaseLineQty} onInput={e=>setPurchaseLineQty((e.currentTarget as HTMLInputElement).value)}/> <input name="price" type="number" min="0" step="0.01" placeholder="Unit cost ₹" value={purchaseLinePrice} onInput={e=>setPurchaseLinePrice((e.currentTarget as HTMLInputElement).value)}/> <button type="button" onClick={addPurchaseLine}>Add line</button>
      </fieldset>
      {purchaseCart.length>0&&<div class="table-wrap" aria-label="Purchase cart"><table><thead><tr><th>Item</th><th>Qty</th><th>Unit cost</th><th>Line total</th><th/></tr></thead><tbody>{purchaseCart.map((l,n)=><tr key={n}><td>{l.item.name}<small> {unitLabel(l.item,l.unitLevel)}</small></td><td>{l.qty}</td><td>₹{(l.unitPricePaise/100).toFixed(2)}</td><td>₹{(Math.round(l.qty*l.unitPricePaise)/100).toFixed(2)}</td><td><button type="button" aria-label={`Remove purchase line ${n+1}`} onClick={()=>removePurchaseLine(n)}>Remove</button></td></tr>)}</tbody></table><p>Lines total: ₹{(purchaseTotalPaise/100).toFixed(2)}</p></div>}
      <button disabled={purchaseBusy||!shopId||!businessDate||!purchaseCart.length}>{purchaseBusy?'Posting…':'Post purchase'}</button>
    </form></section>
  </main>;
}
