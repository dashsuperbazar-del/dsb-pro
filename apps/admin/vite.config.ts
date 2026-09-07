import { defineConfig } from 'vite';
import preact from '@preact/preset-vite';

// base must be absolute ('/'), not relative ('./'): a relative base resolves
// asset URLs against the current path's last segment, so a direct load (a
// real page navigation, not client-side routing) of a multi-segment route
// like /join/:token requests ./assets/... from /join/assets/... (404) instead
// of /assets/.... The whole point of /join/<token> (spec §5) is to be a
// shareable deep link that works on a fresh load, and the app deploys at the
// domain root (dsbpro.in), so absolute base is also the correct choice for
// the real deployment, not just a routing workaround.
//
// Known, deliberately accepted trade-off: this regresses the GitHub Pages
// fallback mirror (a documented Phase 0 gate requirement), which serves the
// build from a subpath (e.g. /<repo>/) — an absolute '/' base means its
// asset URLs point at the Pages *domain* root instead of the repo subpath,
// 404ing there. Accepted by the user because Cloudflare Pages (primary)
// serves from its own root and is unaffected, and GH Pages is a free /
// secondary fallback tier, not the primary deploy target. Revisit with a
// real fix (e.g. a second build with a different base for the GH Pages
// target, or dropping GH Pages once a real domain is live) — tracked in
// Task 13's docs/HANDOVER.md entry.
export default defineConfig({
  base: '/',
  plugins: [preact()],
});
