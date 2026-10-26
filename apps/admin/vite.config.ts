import { execFileSync } from 'node:child_process';
import { defineConfig } from 'vite';
import preact from '@preact/preset-vite';
import { buildVersionJson, resolveCommit } from './src/lib/buildVersion.ts';

// Cloudflare Pages serves the app at the domain root. GitHub Pages uses the
// repository subpath. Keep the default production build root-relative, while
// allowing CI to create the Pages fallback build with VITE_BASE_PATH=/dsb-pro/.
const base = process.env.VITE_BASE_PATH ?? '/';

// Build version marker: dist/version.json {commit, builtAt} and the short commit in Settings.
const commit = resolveCommit(process.env.GITHUB_SHA, () =>
  execFileSync('git', ['rev-parse', 'HEAD'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }),
);
const builtAt = new Date().toISOString();

export default defineConfig({
  base,
  define: {
    __BUILD_COMMIT__: JSON.stringify(commit),
    __BUILD_TIME__: JSON.stringify(builtAt),
  },
  plugins: [
    preact(),
    {
      name: 'dsb-version-json',
      apply: 'build',
      generateBundle(_options, bundle) {
        this.emitFile({
          type: 'asset',
          fileName: 'version.json',
          source: buildVersionJson(commit, builtAt),
        });
        // Every built JS/CSS file, for the service worker to precache at install (D2): screens that
        // load on demand must still open offline even if they were never opened online.
        this.emitFile({
          type: 'asset',
          fileName: 'precache.json',
          source: JSON.stringify(
            Object.keys(bundle)
              .filter((f) => /\.(js|css)$/.test(f))
              .sort(),
          ),
        });
      },
    },
  ],
});
