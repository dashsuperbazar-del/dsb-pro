#!/usr/bin/env bash
# CI only: start a local Supabase stack, retrying infrastructure failures (a port still held by a previous
# container, a registry "Rate exceeded" while pulling images). Same arguments as `supabase start`.
# A real error still fails after 3 attempts.
set -uo pipefail
workdir=()
for ((i = 1; i <= $#; i++)); do
  if [[ "${!i}" == "--workdir" ]]; then j=$((i + 1)); workdir=(--workdir "${!j}"); fi
done
for attempt in 1 2 3; do
  if supabase start "$@"; then exit 0; fi
  echo "supabase start failed (attempt $attempt/3); cleaning up and retrying" >&2
  supabase stop "${workdir[@]}" --no-backup >/dev/null 2>&1 || true
  if [[ ${#workdir[@]} -eq 0 ]]; then
    docker ps -aq --filter 'name=supabase_' | xargs -r docker rm -f >/dev/null 2>&1 || true
    sudo fuser -k 54321/tcp 54322/tcp 54323/tcp 54324/tcp 54325/tcp 54326/tcp 54327/tcp 54328/tcp 54329/tcp >/dev/null 2>&1 || true
  fi
  sleep $((20 * attempt))
done
echo 'supabase start failed 3 times' >&2
exit 1
