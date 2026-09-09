export type CatalogSearchItem={id:string;name:string;sku?:string|null};
export function searchCatalogItems<T extends CatalogSearchItem>(items:readonly T[],query:string,limit=50):T[]{
  const q=query.trim().toLocaleLowerCase('en-IN');
  if(limit<=0)return [];
  if(!q)return items.slice(0,limit);
  const starts:T[]=[]; const contains:T[]=[];
  for(const item of items){
    const name=item.name.toLocaleLowerCase('en-IN');
    const sku=(item.sku??'').toLocaleLowerCase('en-IN');
    if(name.startsWith(q)||sku.startsWith(q))starts.push(item);
    else if(name.includes(q)||sku.includes(q))contains.push(item);
    if(starts.length>=limit)break;
  }
  if(starts.length<limit){
    for(const item of contains){starts.push(item);if(starts.length>=limit)break;}
  }
  return starts;
}
