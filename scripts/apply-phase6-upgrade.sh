#!/usr/bin/env bash
set -euo pipefail

usage() {
  echo "usage: $0 <database-url> <foundation|hardening|phase65|batcha|batchb|all> [...]" >&2
  exit 2
}

[[ $# -ge 2 ]] || usage
database_url=$1
shift

script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
repo_root=$(cd "$script_dir/.." && pwd)
manifest="$repo_root/supabase/phase6-upgrade-manifest.txt"

declare -A requested=()
for group in "$@"; do
  case "$group" in
    foundation|hardening|phase65|batcha|batchb) requested["$group"]=1 ;;
    all) requested[foundation]=1; requested[hardening]=1; requested[phase65]=1; requested[batcha]=1; requested[batchb]=1 ;;
    *) echo "Unknown Phase 6 migration group: $group" >&2; usage ;;
  esac
done

files=()
previous_version=0000
while read -r version group relative_path extra; do
  [[ -n "${version:-}" ]] || continue
  [[ "$version" == \#* ]] && continue
  [[ -z "${extra:-}" ]] || { echo "Invalid manifest row for $version" >&2; exit 1; }
  [[ "$version" =~ ^[0-9]{4}$ ]] || { echo "Invalid migration version: $version" >&2; exit 1; }
  [[ "$version" > "$previous_version" ]] || { echo "Manifest is not strictly ordered at $version" >&2; exit 1; }
  [[ "$relative_path" == supabase/migrations/${version}_*.sql ]] || {
    echo "Manifest path does not match version $version: $relative_path" >&2
    exit 1
  }
  [[ -f "$repo_root/$relative_path" ]] || { echo "Missing migration: $relative_path" >&2; exit 1; }
  previous_version=$version
  if [[ -n "${requested[$group]:-}" ]]; then
    files+=("$repo_root/$relative_path")
  fi
done < "$manifest"

[[ ${#files[@]} -gt 0 ]] || { echo "No migrations selected" >&2; exit 1; }

psql_args=()
for file in "${files[@]}"; do
  psql_args+=(-f "$file")
  echo "Queued migration: ${file#"$repo_root/"}"
done

# One psql process and one transaction make every selected group an all-or-nothing
# upgrade. ON_ERROR_STOP prevents psql from committing after any SQL failure.
psql "$database_url" -X -v ON_ERROR_STOP=1 --single-transaction "${psql_args[@]}"
