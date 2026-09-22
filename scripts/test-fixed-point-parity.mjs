import pg from 'pg';
import { quantityTimesPaise } from '../packages/core/src/fixedPoint.ts';

const { Client } = pg;
const connectionString = process.env.TEST_DATABASE_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54322/postgres';

// Deterministic xorshift32: a failed vector can be reproduced from its index.
let state = 0x6d2b79f5;
function next() {
  state ^= state << 13; state ^= state >>> 17; state ^= state << 5;
  return state >>> 0;
}

const vectors = [{ id: 0, qty: '0.145', price: 100 }];
for (let id = 1; id <= 5000; id += 1) {
  const micros = BigInt((next() % 25_000_000) + 1);
  const whole = micros / 1_000_000n;
  const fraction = String(micros % 1_000_000n).padStart(6, '0').replace(/0+$/, '');
  vectors.push({ id, qty: fraction ? `${whole}.${fraction}` : String(whole), price: next() % 1_000_001 });
}

const client = new Client({ connectionString });
await client.connect();
try {
  const result = await client.query(`
    select id,round(qty::numeric*price)::bigint as total
    from jsonb_to_recordset($1::jsonb) as sample(id integer,qty text,price bigint)
    order by id
  `, [JSON.stringify(vectors)]);
  for (const row of result.rows) {
    const vector = vectors[row.id];
    const actual = quantityTimesPaise(vector.qty, vector.price);
    const expected = Number(row.total);
    if (actual !== expected) {
      throw new Error(`fixed-point parity failed at vector ${row.id}: ${JSON.stringify({ vector, actual, expected })}`);
    }
  }
  console.log(`fixed-point parity: ${vectors.length} TypeScript/PostgreSQL quantity × paise vectors matched, including 0.145 × 100 = 15`);
} finally {
  await client.end();
}
