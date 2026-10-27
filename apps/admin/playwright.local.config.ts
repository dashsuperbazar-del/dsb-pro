import { defineConfig } from '@playwright/test';

// Local only (not committed): the same as playwright.config.ts on a free port (4173 is taken by another builder).
export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  retries: 0,
  workers: 3,
  use: {
    baseURL: 'http://localhost:4180',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  webServer: {
    command: 'pnpm exec vite preview --port 4180 --strictPort',
    port: 4180,
    reuseExistingServer: false,
  },
});
