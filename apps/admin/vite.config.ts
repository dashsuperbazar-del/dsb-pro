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
export default defineConfig({
  base: '/',
  plugins: [preact()],
});
