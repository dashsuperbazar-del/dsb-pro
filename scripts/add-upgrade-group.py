#!/usr/bin/env python3
"""Wire a new migration's upgrade group everywhere the P2 template needs it (run from the repo root).

Usage:
  scripts/add-upgrade-group.py GROUP VERSION FILE PREVIOUS_GROUP "Title" ANCHORS_SQL N_ANCHORS ANON_GRANT_SQL ANON_REVOKE_SQL

  GROUP           new group name, e.g. orderadjust
  VERSION         migration number, e.g. 0083
  FILE            migration file name, e.g. 0083_order_adjust.sql
  PREVIOUS_GROUP  the group it must follow (the last one in GROUP_ORDER)
  ANCHORS_SQL     lines of "   (boolean expression)," each true when the migration is applied; every anchor must
                  require its objects to EXIST (a missing object must count as false, or an un-upgraded database
                  is misread as partial)
  N_ANCHORS       how many anchor lines
  ANON_*_SQL      a grant that must make the probe refuse (tamper proof) and its revoke

Edits: scripts/apply-migrations-with-receipts.mjs (GROUP_ORDER), scripts/verify-migration-manifest.mjs
(ALLOWED_GROUPS + version map), scripts/apply-phase6-upgrade.sh, supabase/phase6-upgrade-manifest.txt,
scripts/inspect-phase6-upgrade-state.sh (probe + needs_upgrade + printed state), .github/workflows/ci.yml (disposable
proof step + live apply step). Afterwards: run the inspector on a local DB (expect state 1), on a DB without the
migration's objects (expect state 0), node scripts/verify-migration-manifest.mjs, and regenerate packages/db/src/types.ts.
"""
import sys,re
grp,ver,fname,prev,title,anchors_sql,n,anon_grant,anon_revoke=sys.argv[1:10]
def ed(p,a,b):
    s=open(p).read(); assert s.count(a)==1,(p,a[:60]); open(p,'w').write(s.replace(a,b,1))
ed('scripts/apply-migrations-with-receipts.mjs',f"  '{prev}',\n];",f"  '{prev}',\n  '{grp}',\n];")
ed('scripts/verify-migration-manifest.mjs',f"  '{prev}',\n]);",f"  '{prev}',\n  '{grp}',\n]);")
s=open('scripts/verify-migration-manifest.mjs').read()
line=[l for l in s.split('\n') if l.strip().startswith("'0") and f"['{prev}'," in l][0]
ed('scripts/verify-migration-manifest.mjs',line+'\n',line+'\n'+f"  '{ver}': ['{grp}', 'supabase/migrations/{fname}'],\n")
p='scripts/apply-phase6-upgrade.sh'; s=open(p).read(); s=s.replace(f'|{prev}|all',f'|{prev}|{grp}|all'); open(p,'w').write(s)
with open('supabase/phase6-upgrade-manifest.txt','a') as f: f.write(f"{ver} {grp} supabase/migrations/{fname}\n")
p='scripts/inspect-phase6-upgrade-state.sh'; s=open(p).read()
probe=f'''{grp}_probe=$(psql "$database_url" -X -v ON_ERROR_STOP=1 -At -F' ' <<'SQL'
do $$ begin
 create temp table _{grp}_receipt (present boolean);
 if to_regclass('public.app_migration_receipts') is not null then
   insert into _{grp}_receipt select exists(select 1 from public.app_migration_receipts where version='{ver}');
 else insert into _{grp}_receipt values(false); end if;
end $$;
select (select present from _{grp}_receipt),
 (select count(*) from (values
{anchors_sql}
 ) p(ok) where ok);
SQL
)
read -r {grp}_receipt {grp}_anchors <<<"$(tail -n 1 <<<"${grp}_probe")"
case "${grp}_receipt:${grp}_anchors" in
 f:0) {grp}=0; needs_{grp}=true ;;
 f:{n}) {grp}=1; needs_{grp}=true ;;
 t:{n}) {grp}=2; needs_{grp}=false ;;
 *) echo "{title} ({ver}) partial/drift state (${grp}_receipt/${grp}_anchors). Refusing migration." >&2; exit 1 ;;
esac
if [[ "${grp}" == '2' ]]; then
 {grp}_expected=$(sha256sum "$repo_root/supabase/migrations/{fname}" | cut -d' ' -f1)
 {grp}_recorded=$(psql "$database_url" -X -v ON_ERROR_STOP=1 -At -c "select checksum_sha256 from public.app_migration_receipts where version='{ver}'")
 [[ "${grp}_expected" == "${grp}_recorded" ]] || {{ echo '{ver} receipt checksum mismatch. Refusing migration.' >&2; exit 1; }}
fi
if [[ "${grp}" != '0' && "${prev}" != '2' && ! ( "${grp}" == '1' && "${prev}" == '1' ) ]]; then
 echo '{title} ({ver}) appears ahead of completed {prev}. Refusing migration.' >&2; exit 1
fi

emit_state() {{'''
assert s.count('\nemit_state() {')==1
s=s.replace('\nemit_state() {','\n'+probe,1)
a=f'"$needs_{prev}" == "false" ]]; then needs_upgrade=false; fi'
assert s.count(a)==1
s=s.replace(a,f'"$needs_{prev}" == "false" && "$needs_{grp}" == "false" ]]; then needs_upgrade=false; fi',1)
a=f"  printf 'needs_{prev}=%s\\n' \"$needs_{prev}\"\n"
assert s.count(a)==1
s=s.replace(a,a+f"  printf '{grp}_state=%s\\n' \"${grp}\"\n  printf 'needs_{grp}=%s\\n' \"$needs_{grp}\"\n",1)
open(p,'w').write(s)
p='.github/workflows/ci.yml'; s=open(p).read()
old=f"""          grep -Fx 'needs_upgrade=false' <<<"$(scripts/inspect-phase6-upgrade-state.sh "$PROOF_DB_URL")" >/dev/null
          echo 'DISPOSABLE """
i=s.index(old); j=s.index("\n",s.index("echo 'DISPOSABLE ",i))
s=s[:i]+s[i:j+1].replace("needs_upgrade=false",f"needs_{prev}=false",1)+f"""      - name: Prove {grp} upgrade ({title}; apply, no-op, tamper/partial refusal)
        env:
          PROOF_DB_URL: postgresql://postgres:postgres@127.0.0.1:54322/postgres
        run: |
          set -euo pipefail
          grep -Fx 'needs_{grp}=true' <<<"$(scripts/inspect-phase6-upgrade-state.sh "$PROOF_DB_URL")" >/dev/null
          scripts/apply-phase6-upgrade.sh "$PROOF_DB_URL" {grp}
          grep -Fx 'needs_{grp}=false' <<<"$(scripts/inspect-phase6-upgrade-state.sh "$PROOF_DB_URL")" >/dev/null
          grep -Fx 'needs_{prev}=false' <<<"$(scripts/inspect-phase6-upgrade-state.sh "$PROOF_DB_URL")" >/dev/null
          scripts/apply-phase6-upgrade.sh "$PROOF_DB_URL" {grp}
          expected_checksum=$(sha256sum supabase/migrations/{fname} | cut -d' ' -f1)
          psql "$PROOF_DB_URL" -X -v ON_ERROR_STOP=1 -c "update app_migration_receipts set checksum_sha256=repeat('0',64) where version='{ver}'"
          if scripts/inspect-phase6-upgrade-state.sh "$PROOF_DB_URL"; then echo '{ver} tamper accepted'; exit 1; fi
          psql "$PROOF_DB_URL" -X -v ON_ERROR_STOP=1 -c "update app_migration_receipts set checksum_sha256='$expected_checksum' where version='{ver}'"
          psql "$PROOF_DB_URL" -X -v ON_ERROR_STOP=1 -c "{anon_grant}"
          if scripts/inspect-phase6-upgrade-state.sh "$PROOF_DB_URL"; then echo 'Anonymous {grp} access accepted'; exit 1; fi
          psql "$PROOF_DB_URL" -X -v ON_ERROR_STOP=1 -c "{anon_revoke}"
          grep -Fx 'needs_upgrade=false' <<<"$(scripts/inspect-phase6-upgrade-state.sh "$PROOF_DB_URL")" >/dev/null
          echo 'DISPOSABLE {grp.upper()} UPGRADE: PASS'
"""+s[j+1:]
old=f"""        run: scripts/apply-phase6-upgrade.sh "$SUPABASE_DB_URL" {prev}
"""
assert s.count(old)==1
s=s.replace(old,old+f"""      - name: Apply {grp} ({title}) atomically
        if: steps.preflight.outputs.needs_{grp} == 'true'
        env:
          SUPABASE_DB_URL: ${{{{ secrets.SUPABASE_DB_URL }}}}
        run: scripts/apply-phase6-upgrade.sh "$SUPABASE_DB_URL" {grp}
""",1)
open(p,'w').write(s)
