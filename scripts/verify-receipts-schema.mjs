// Exact verification of app_migration_receipts against what migration 0044
// creates. Shared by scripts/attended-baseline-receipt-init.mjs and
// scripts/bootstrap-disposable-receipts.mjs so both refuse the same drift.
//
// Every comparison is against a canonical Postgres rendering, not a
// substring search: a CHECK allowing `{1,64}` or `{1,8}` must fail, which
// "definition contains 0-9a-f and 64" would have accepted.

export const EXPECTED_COLUMNS = Object.freeze({
  version: { data_type: 'text', is_nullable: 'NO', column_default: null },
  checksum_sha256: { data_type: 'text', is_nullable: 'NO', column_default: null },
  applied_at: { data_type: 'timestamp with time zone', is_nullable: 'NO', column_default: 'now()' },
  applied_by: { data_type: 'text', is_nullable: 'NO', column_default: 'CURRENT_USER' },
});

// Exact pg_get_constraintdef() output for each constraint 0044 creates,
// captured from a real database with 0044 applied.
export const EXPECTED_CONSTRAINTS = Object.freeze({
  app_migration_receipts_pkey: { contype: 'p', definition: 'PRIMARY KEY (version)' },
  app_migration_receipts_checksum_format: {
    contype: 'c',
    definition: "CHECK ((checksum_sha256 ~ '^[0-9a-f]{64}$'::text))",
  },
  app_migration_receipts_version_format: {
    contype: 'c',
    definition: "CHECK ((version ~ '^[0-9]{4}$'::text))",
  },
});

const PROHIBITED_ROLES = ['anon', 'authenticated', 'public'];
const ALL_TABLE_PRIVILEGES = ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'];

/** Returns a list of human-readable mismatches; empty means exact match. */
export async function verifyReceiptsSchema(client) {
  const problems = [];

  const exists = (
    await client.query(`select to_regclass('public.app_migration_receipts') is not null as present`)
  ).rows[0].present;
  if (!exists) return ['app_migration_receipts does not exist'];

  const columns = await client.query(`
    select column_name, data_type, is_nullable, column_default
    from information_schema.columns
    where table_schema = 'public' and table_name = 'app_migration_receipts'
  `);
  const actualColumns = Object.fromEntries(columns.rows.map((r) => [r.column_name, r]));
  for (const [name, expected] of Object.entries(EXPECTED_COLUMNS)) {
    const actual = actualColumns[name];
    if (!actual) {
      problems.push(`column ${name}: missing`);
      continue;
    }
    for (const field of ['data_type', 'is_nullable', 'column_default']) {
      // null expected means the column must have NO default, not "unchecked".
      if ((actual[field] ?? null) !== expected[field]) {
        problems.push(`column ${name}: ${field} is ${JSON.stringify(actual[field] ?? null)}, expected ${JSON.stringify(expected[field])}`);
      }
    }
  }
  for (const name of Object.keys(actualColumns)) {
    if (!(name in EXPECTED_COLUMNS)) problems.push(`unexpected column: ${name}`);
  }

  const constraints = await client.query(`
    select conname, contype, convalidated, pg_get_constraintdef(oid) as definition
    from pg_constraint
    where conrelid = 'public.app_migration_receipts'::regclass
  `);
  const actualConstraints = Object.fromEntries(constraints.rows.map((r) => [r.conname, r]));
  for (const [name, expected] of Object.entries(EXPECTED_CONSTRAINTS)) {
    const actual = actualConstraints[name];
    if (!actual) {
      problems.push(`constraint ${name}: missing`);
      continue;
    }
    if (actual.contype !== expected.contype) problems.push(`constraint ${name}: type ${actual.contype}, expected ${expected.contype}`);
    if (actual.definition !== expected.definition) {
      problems.push(`constraint ${name}: definition ${JSON.stringify(actual.definition)}, expected ${JSON.stringify(expected.definition)}`);
    }
    if (actual.convalidated !== true) problems.push(`constraint ${name}: not validated (NOT VALID)`);
  }
  for (const name of Object.keys(actualConstraints)) {
    if (!(name in EXPECTED_CONSTRAINTS)) problems.push(`unexpected constraint: ${name}`);
  }

  const rls = (
    await client.query(`select relrowsecurity from pg_class where oid = 'public.app_migration_receipts'::regclass`)
  ).rows[0].relrowsecurity;
  if (rls !== true) problems.push('row level security is not enabled');

  const policies = await client.query(`select policyname from pg_policies where schemaname='public' and tablename='app_migration_receipts'`);
  if (policies.rowCount > 0) {
    problems.push(`unexpected RLS policies: ${policies.rows.map((r) => r.policyname).join(', ')}`);
  }

  // Effective privileges (direct, PUBLIC-inherited, or via role membership),
  // every table privilege, not only SELECT.
  for (const role of PROHIBITED_ROLES) {
    const roleExists = role === 'public' || (await client.query('select 1 from pg_roles where rolname = $1', [role])).rowCount > 0;
    if (!roleExists) continue;
    for (const privilege of ALL_TABLE_PRIVILEGES) {
      const granted = role === 'public'
        ? (
            await client.query(
              `select exists(select 1 from information_schema.role_table_grants
                 where table_schema='public' and table_name='app_migration_receipts'
                   and grantee='PUBLIC' and privilege_type=$1) as granted`,
              [privilege],
            )
          ).rows[0].granted
        : (
            await client.query(`select has_table_privilege($1, 'public.app_migration_receipts', $2) as granted`, [role, privilege])
          ).rows[0].granted;
      if (granted) problems.push(`${role} has effective ${privilege} on app_migration_receipts`);
    }
  }

  // Required access: 0044 grants SELECT to backup_ro when that role exists.
  const backupRo = (await client.query(`select 1 from pg_roles where rolname = 'backup_ro'`)).rowCount > 0;
  if (backupRo) {
    const canRead = (
      await client.query(`select has_table_privilege('backup_ro', 'public.app_migration_receipts', 'SELECT') as granted`)
    ).rows[0].granted;
    if (!canRead) problems.push('backup_ro exists but lacks required SELECT on app_migration_receipts');
  }

  return problems;
}
