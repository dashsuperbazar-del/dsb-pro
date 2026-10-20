import { shortCommit } from '../lib/buildVersion';

// Set by vite.config.ts `define` (same values as dist/version.json).
declare const __BUILD_COMMIT__: string | undefined;
declare const __BUILD_TIME__: string | undefined;
const RUNNING_COMMIT = typeof __BUILD_COMMIT__ === 'string' ? __BUILD_COMMIT__ : 'unknown';
const RUNNING_TIME = typeof __BUILD_TIME__ === 'string' ? __BUILD_TIME__ : '';

/** "App version 84969ec · built 2026-10-20": which build this device is running. */
export function BuildVersion({
  commit = RUNNING_COMMIT,
  builtAt = RUNNING_TIME,
}: {
  commit?: string;
  builtAt?: string;
}) {
  return (
    <p class="muted" data-testid="build-version">
      App version {shortCommit(commit)}
      {builtAt ? ` · built ${builtAt.slice(0, 10)}` : ''}
    </p>
  );
}
