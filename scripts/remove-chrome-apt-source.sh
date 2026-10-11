#!/usr/bin/env bash
# GitHub runners may ship an optional Chrome apt source. Playwright downloads
# its own browser; remove this source before apt to avoid metadata failures.
set -euo pipefail
sources_dir=${1:-/etc/apt/sources.list.d}
matches=$(mktemp)
trap 'rm -f -- "$matches"' EXIT

# grep's 1 means no matching source, not a failed scan. Preserve every other
# failure and finish scanning before deleting anything. NULs preserve filenames.
if grep -RIlZ -F 'dl.google.com/linux/chrome' "$sources_dir" > "$matches"; then
  while IFS= read -r -d '' source; do
    sudo rm -f -- "$source"
  done < "$matches"
else
  status=$?
  if [[ "$status" -ne 1 ]]; then
    exit "$status"
  fi
fi
