import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
const sql=readFileSync(fileURLToPath(new URL('../supabase/migrations/0062_party_merge.sql',import.meta.url)),'utf8').replace(/\r\n/g,'\n');
const body=/create or replace function post_purchase\([\s\S]*?as \$\$([\s\S]*?)\$\$;/i.exec(sql)?.[1];
if(!body)throw new Error('Party merge purchase wrapper body not found');
process.stdout.write(createHash('md5').update(body).digest('hex'));
