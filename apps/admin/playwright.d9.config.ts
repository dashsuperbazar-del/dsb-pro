import { defineConfig } from '@playwright/test';

// Local-only (not committed): same as playwright.config.ts on a free port.
export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  retries: 0,
  workers: 2,
  use: { baseURL: 'http://localhost:4190', trace: 'retain-on-failure', screenshot: 'only-on-failure' },
  webServer: { command: 'pnpm exec vite preview --port 4190 --strictPort', port: 4190, reuseExistingServer: false },
});
