export type Locale='en'|'hi';
export type MessageKey='salesPos'|'customersLedger'|'salesHistory'|'inventoryPurchases'|'home'|'printA4'|'printThermal'|'voidSale'|'language';

const messages:Record<Locale,Record<MessageKey,string>>={
  en:{salesPos:'Sales POS',customersLedger:'Customers & ledger',salesHistory:'Sales history',inventoryPurchases:'Inventory & purchases',home:'Home',printA4:'Print A4',printThermal:'Print thermal',voidSale:'Void sale',language:'Language'},
  hi:{salesPos:'बिक्री POS',customersLedger:'ग्राहक और खाता',salesHistory:'बिक्री इतिहास',inventoryPurchases:'स्टॉक और खरीद',home:'होम',printA4:'A4 प्रिंट',printThermal:'थर्मल प्रिंट',voidSale:'बिक्री रद्द करें',language:'भाषा'},
};

const key='dsb-pro-locale';
export function getLocale():Locale { return typeof localStorage!=='undefined'&&localStorage.getItem(key)==='hi'?'hi':'en'; }
export function setLocale(locale:Locale){ if(typeof localStorage!=='undefined') localStorage.setItem(key,locale); }
export function t(message:MessageKey,locale:Locale=getLocale()){ return messages[locale][message]; }
