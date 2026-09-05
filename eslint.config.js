import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';

export default tseslint.config(
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      'packages/db/src/types.ts',
      '.superpowers/**',
    ],
  },
  {
    // Node-context files: build/dev tooling scripts, not app code that ships to the browser.
    files: ['scripts/**/*.{js,mjs,ts}', '*.config.{js,ts,mjs}', 'apps/*/vite.config.ts'],
    languageOptions: {
      globals: globals.node,
    },
  }
);
