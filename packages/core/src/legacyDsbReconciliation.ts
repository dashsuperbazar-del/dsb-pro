type JsonObject = Record<string, unknown>;

export type LegacyDsbDayPaymentModes = {
  cashPaise:number;
  upiPaise:number;
  cardPaise:number;
  bankPaise:number;
  otherPaise:number;
};

export type LegacyDsbDaySummary = {
  sourceVersion:number;
  exportedAt:string;
  businessDate:string;
  invoiceCount:number;
  salesTotalPaise:number;
  directSaleReceiptsPaise:number;
  creditCreatedPaise:number;
  standaloneCustomerReceiptsPaise:number;
  allCustomerReceiptsPaise:number;
  paymentModes:LegacyDsbDayPaymentModes;
  returnCreditPaise:number;
  warnings:string[];
};

export type DsbProComparableDay = {
  invoiceCount:number;
  salesTotalPaise:number;
  directSaleReceiptsPaise:number;
  creditCreatedPaise:number;
  standaloneCustomerReceiptsPaise:number;
  allCustomerReceiptsPaise:number;
  paymentModes:{
    cash:number;
    upi:number;
    card:number;
    bank:number;
    other:number;
  };
};

export type LegacyDsbDayComparisonRow = {
  key:string;
  label:string;
  legacy:number;
  dsbPro:number;
  kind:'count'|'paise';
  match:boolean;
};

export type LegacyDsbDayComparison = {
  legacy:LegacyDsbDaySummary;
  rows:LegacyDsbDayComparisonRow[];
  exactMatch:boolean;
  manualReviewRequired:boolean;
};

function object(value:unknown):JsonObject|null {
  return value!==null && typeof value==='object' && !Array.isArray(value) ? value as JsonObject : null;
}
function num(value:unknown):number {
  const n=typeof value==='number'?value:Number(value);
  return Number.isFinite(n)?n:0;
}
function paise(value:unknown):number { return Math.round(num(value)*100); }
function txt(value:unknown):string { return typeof value==='string'?value.trim():''; }

function addMode(modes:LegacyDsbDayPaymentModes,modeRaw:unknown,amountPaise:number,warnings:string[],context:string){
  const mode=txt(modeRaw).toLowerCase();
  if(mode==='cash')modes.cashPaise+=amountPaise;
  else if(mode==='upi')modes.upiPaise+=amountPaise;
  else if(mode==='cheque'||mode==='bank')modes.bankPaise+=amountPaise;
  else if(mode==='card')modes.cardPaise+=amountPaise;
  else {
    modes.otherPaise+=amountPaise;
    warnings.push(`${context}: unknown payment mode "${mode||'blank'}" mapped to Other.`);
  }
}

export function summarizeLegacyDsbDayBackup(snapshot:unknown,businessDate:string):LegacyDsbDaySummary {
  if(!/^\d{4}-\d{2}-\d{2}$/.test(businessDate)) throw new Error('Business date must be YYYY-MM-DD.');
  const root=object(snapshot);
  if(!root)throw new Error('Backup must be a JSON object.');
  const sourceVersion=Math.trunc(num(root.version));
  if(sourceVersion!==3)throw new Error(`Unsupported DSB backup version: ${sourceVersion||'unknown'}.`);
  const exportedAt=txt(root.exportedAt);
  if(!exportedAt||Number.isNaN(Date.parse(exportedAt)))throw new Error('Backup exportedAt timestamp is missing or invalid.');

  const warnings:string[]=[];
  const modes:LegacyDsbDayPaymentModes={cashPaise:0,upiPaise:0,cardPaise:0,bankPaise:0,otherPaise:0};
  let invoiceCount=0,salesTotalPaise=0,directSaleReceiptsPaise=0,creditCreatedPaise=0;
  let standaloneCustomerReceiptsPaise=0,returnCreditPaise=0;

  for(const raw of Array.isArray(root.saleInvoices)?root.saleInvoices:[]){
    const inv=object(raw); if(!inv||txt(inv.date)!==businessDate)continue;
    const total=Math.max(0,paise(inv.grandTotal));
    const paymentType=txt(inv.paymentType).toLowerCase();
    invoiceCount+=1;
    salesTotalPaise+=total;
    if(paymentType==='credit')creditCreatedPaise+=total;
    else {
      directSaleReceiptsPaise+=total;
      addMode(modes,paymentType,total,warnings,`Invoice ${txt(inv.id)||'(unknown)'}`);
    }
  }

  for(const raw of Array.isArray(root.salePayments)?root.salePayments:[]){
    const payment=object(raw); if(!payment||txt(payment.date)!==businessDate)continue;
    const amount=Math.max(0,paise(payment.amount));
    const mode=txt(payment.mode).toLowerCase();
    if(mode==='return'){
      returnCreditPaise+=amount;
      warnings.push(`Sale return credit ${txt(payment.id)||'(unknown)'} for ₹${(amount/100).toFixed(2)} requires manual review; Phase 4 does not auto-equate legacy returns with voids.`);
      continue;
    }
    standaloneCustomerReceiptsPaise+=amount;
    addMode(modes,mode,amount,warnings,`Sale payment ${txt(payment.id)||'(unknown)'}`);
  }

  return {
    sourceVersion,exportedAt,businessDate,invoiceCount,salesTotalPaise,directSaleReceiptsPaise,creditCreatedPaise,
    standaloneCustomerReceiptsPaise,
    allCustomerReceiptsPaise:directSaleReceiptsPaise+standaloneCustomerReceiptsPaise,
    paymentModes:modes,returnCreditPaise,warnings,
  };
}

export function compareLegacyDsbDayToPro(snapshot:unknown,businessDate:string,pro:DsbProComparableDay):LegacyDsbDayComparison {
  const legacy=summarizeLegacyDsbDayBackup(snapshot,businessDate);
  const rows:LegacyDsbDayComparisonRow[]=[
    {key:'invoiceCount',label:'Finalized invoices',legacy:legacy.invoiceCount,dsbPro:pro.invoiceCount,kind:'count',match:legacy.invoiceCount===pro.invoiceCount},
    {key:'salesTotal',label:'Sales total',legacy:legacy.salesTotalPaise,dsbPro:pro.salesTotalPaise,kind:'paise',match:legacy.salesTotalPaise===pro.salesTotalPaise},
    {key:'directReceipts',label:'Direct sale receipts',legacy:legacy.directSaleReceiptsPaise,dsbPro:pro.directSaleReceiptsPaise,kind:'paise',match:legacy.directSaleReceiptsPaise===pro.directSaleReceiptsPaise},
    {key:'creditCreated',label:'Credit created on sales',legacy:legacy.creditCreatedPaise,dsbPro:pro.creditCreatedPaise,kind:'paise',match:legacy.creditCreatedPaise===pro.creditCreatedPaise},
    {key:'standaloneReceipts',label:'Standalone customer receipts',legacy:legacy.standaloneCustomerReceiptsPaise,dsbPro:pro.standaloneCustomerReceiptsPaise,kind:'paise',match:legacy.standaloneCustomerReceiptsPaise===pro.standaloneCustomerReceiptsPaise},
    {key:'allReceipts',label:'All customer receipts',legacy:legacy.allCustomerReceiptsPaise,dsbPro:pro.allCustomerReceiptsPaise,kind:'paise',match:legacy.allCustomerReceiptsPaise===pro.allCustomerReceiptsPaise},
    {key:'cash',label:'Cash',legacy:legacy.paymentModes.cashPaise,dsbPro:pro.paymentModes.cash,kind:'paise',match:legacy.paymentModes.cashPaise===pro.paymentModes.cash},
    {key:'upi',label:'UPI',legacy:legacy.paymentModes.upiPaise,dsbPro:pro.paymentModes.upi,kind:'paise',match:legacy.paymentModes.upiPaise===pro.paymentModes.upi},
    {key:'card',label:'Card',legacy:legacy.paymentModes.cardPaise,dsbPro:pro.paymentModes.card,kind:'paise',match:legacy.paymentModes.cardPaise===pro.paymentModes.card},
    {key:'bank',label:'Bank / cheque',legacy:legacy.paymentModes.bankPaise,dsbPro:pro.paymentModes.bank,kind:'paise',match:legacy.paymentModes.bankPaise===pro.paymentModes.bank},
    {key:'other',label:'Other',legacy:legacy.paymentModes.otherPaise,dsbPro:pro.paymentModes.other,kind:'paise',match:legacy.paymentModes.otherPaise===pro.paymentModes.other},
  ];
  const manualReviewRequired=legacy.returnCreditPaise>0||legacy.warnings.some(w=>w.includes('unknown payment mode'));
  return {legacy,rows,exactMatch:rows.every(r=>r.match)&&!manualReviewRequired,manualReviewRequired};
}
