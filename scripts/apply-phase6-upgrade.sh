#!/usr/bin/env bash
set -euo pipefail

usage() {
  echo "usage: $0 <database-url> <foundation|hardening|phase65|batcha|batchb|p1|all> [...]" >&2
  exit 2
}

[[ $# -ge 2 ]] || usage
database_url=$1
shift

script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
repo_root=$(cd "$script_dir/.." && pwd)

for group in "$@"; do
  case "$group" in
    foundation|hardening|phase65|batcha|batchb|p1|all) ;;
    *) echo "Unknown Phase 6 migration group: $group" >&2; usage ;;
  esac
done

# This shell script is kept as a backward-compatible wrapper with an
# unchanged invocation syntax (mechanism point 3). Manifest validation,
# checksum computation and receipt insertion now live in the Node pg
# transaction runner, which avoids the shell/SQL quoting hazards of
# generating parameterized INSERT statements as text. One `node` process
# opens exactly one transaction per invocation covering every selected
# group; it applies each file's SQL then inserts its receipt, and rolls
# back both schema and receipt changes together on any failure.
exec node "$repo_root/scripts/apply-migrations-with-receipts.mjs" "$database_url" "$@"
