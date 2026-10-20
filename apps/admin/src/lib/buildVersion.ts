// Build version marker. Pure (no DOM, no Node APIs): vite.config.ts uses it at build time to write
// dist/version.json and to define __BUILD_COMMIT__/__BUILD_TIME__; Settings shows the short commit.
const COMMIT = /^[0-9a-f]{7,40}$/;

/** GITHUB_SHA when it is a commit id, else `git rev-parse HEAD`, else "unknown". */
export function resolveCommit(envSha: string | undefined, gitHead: () => string): string {
  const env = (envSha ?? '').trim().toLowerCase();
  if (COMMIT.test(env)) return env;
  try {
    const head = gitHead().trim().toLowerCase();
    if (COMMIT.test(head)) return head;
  } catch {
    /* no git (e.g. a source tarball): fall through */
  }
  return 'unknown';
}

export function buildVersionJson(commit: string, builtAt: string): string {
  return `${JSON.stringify({ commit, builtAt })}\n`;
}

export function shortCommit(commit: string): string {
  return COMMIT.test(commit) ? commit.slice(0, 7) : 'unknown';
}
