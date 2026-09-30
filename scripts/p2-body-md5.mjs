// Prints md5 of get_item_sales_report's body exactly as written between the
// $$ delimiters in migration 0045. Postgres stores that text verbatim in
// pg_proc.prosrc, so md5(prosrc) on a database where 0045 is installed
// unmodified equals this value (used by inspect-phase6-upgrade-state.sh).
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
// Normalise CRLF: a Windows checkout (core.autocrlf) must not fake drift;
// the migration was applied from LF bytes.
const sql = readFileSync(join(root, 'supabase/migrations/0045_item_sales_fix.sql'), 'utf8').replace(/\r\n/g, '\n');
const match = /create or replace function get_item_sales_report\([^)]*\)[\s\S]*?\sas \$\$([\s\S]*?)\$\$;/.exec(sql);
if (!match) {
  console.error('could not locate get_item_sales_report body in 0045');
  process.exit(1);
}
process.stdout.write(createHash('md5').update(match[1]).digest('hex'));
