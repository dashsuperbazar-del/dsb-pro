import { defineConfig } from 'vite';
import preact from '@preact/preset-vite';

// Cloudflare Pages serves the app at the domain root. GitHub Pages uses the
// repository subpath. Keep the default production build root-relative, while
// allowing CI to create the Pages fallback build with VITE_BASE_PATH=/dsb-pro/.
const base = process.env.VITE_BASE_PATH ?? '/';

export default defineConfig({
  base,
  plugins: [preact()],
});
