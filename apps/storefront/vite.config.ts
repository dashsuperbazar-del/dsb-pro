import { defineConfig } from 'vite';
import preact from '@preact/preset-vite';

// Public online shop (SF4). Separate site (Cloudflare Pages project dsb-shop on pages.dev).
export default defineConfig({ plugins: [preact()], build: { target: 'es2020' } });
