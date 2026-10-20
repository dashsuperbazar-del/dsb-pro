import { test, expect, type Page, type Request } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import {
  allowedBaselineUrl,
  requestCategory,
  summarize,
} from '../../../scripts/navigation-baseline.mjs';

const enabled = process.env.SP0_NAVIGATION === '1';
const samples = 7;
const check = expect.configure({ timeout: 60_000 });
const profiles = [
  { name: 'desktop-reference', cpu: 1, latency: 0, down: -1, up: -1 },
  {
    name: 'mobile-synthetic',
    cpu: 4,
    latency: 150,
    down: (1_600 * 1024) / 8,
    up: (750 * 1024) / 8,
  },
];
const routes = ['/pos', '/inventory', '/purchases', '/suppliers', '/customers'];

async function ready(page: Page, path: string) {
  const main = page.locator('main');
  if (path === '/pos') {
    await check(main.getByRole('heading', { name: 'Sales POS', exact: true })).toBeVisible();
    await check(main.getByText('Showing up to 50 matches from 10000 items.')).toBeVisible();
    await check(main.getByLabel('Find product', { exact: true })).toBeEnabled();
  } else if (path === '/inventory') {
    await check(
      main.getByRole('heading', { name: 'Inventory & purchases', exact: true }),
    ).toBeVisible();
    // The catalog list is bounded to 50 rows; the line below proves all 10,000 items were loaded.
    await check(main.getByText('Showing up to 50 matches · 10000 items')).toBeVisible();
    await check(
      main.getByRole('combobox', { name: /^Item details\b/ }).locator('option'),
    ).toHaveCount(51); // "Choose…" + 50 matches: the picker no longer renders 10,001 options
  } else if (path === '/purchases') {
    await check(main.getByRole('heading', { name: 'Purchases', exact: true })).toBeVisible();
    await check(main.getByText('Showing 0 of 0 loaded bills.', { exact: false })).toBeVisible();
    await check(main.getByText('Loading purchases…', { exact: true })).toHaveCount(0);
    await check(main.getByRole('link', { name: 'New purchase', exact: true })).toBeVisible();
  } else if (path === '/suppliers') {
    await check(
      main.getByRole('heading', { name: 'Suppliers & payments', exact: true }),
    ).toBeVisible();
    await check(main.getByLabel('Supplier', { exact: true }).locator('option')).toHaveCount(9);
  } else {
    await check(
      main.getByRole('heading', { name: 'Customers & ledger', exact: true }),
    ).toBeVisible();
    await check(main.getByRole('combobox', { name: /^Customer\b/ }).locator('option')).toHaveCount(
      9,
    );
    // The create form lives in a collapsed <details>; its summary is the visible, actionable control.
    await check(main.getByText('Add customer', { exact: true })).toBeVisible();
  }
  // A useful rendered state, followed by two frames; heading-only timings hide network waits.
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
}

async function menu(page: Page, path: string) {
  // Unmeasured menu setup. Measure the actual link tap, never page.goto masquerading as SPA navigation.
  const home = page.locator('a[href="/"]:visible').first();
  await home.click();
  if (!(await page.locator(`a[href="${path}"]:visible`).count())) {
    await page.locator('a[href="/more"]:visible').first().click();
  }
  await check(page.locator(`a[href="${path}"]:visible`).first()).toBeVisible();
}

test.describe('SP0 read/navigation baseline (no optimization or live target)', () => {
  test.skip(!enabled, 'Explicit disposable performance workflow only.');
  for (const profile of profiles)
    test(profile.name, async ({ browser, baseURL }, testInfo) => {
      test.setTimeout(1_800_000);
      expect(baseURL && allowedBaselineUrl(baseURL)).toBeTruthy();
      expect(process.env.PHASE6_PERF_EMAIL).toBeTruthy();
      expect(process.env.PHASE6_PERF_PASSWORD).toBeTruthy();
      const context = await browser.newContext({
        baseURL,
        viewport: { width: 390, height: 844 },
        serviceWorkers: 'block',
      });
      const blocked: string[] = [];
      await context.route('**/*', (route) => {
        if (allowedBaselineUrl(route.request().url())) return route.continue();
        blocked.push('non-loopback request blocked');
        return route.abort('blockedbyclient');
      });
      await context.addInitScript(() =>
        localStorage.setItem('dsb-pro-device-id', 'phase6-perf-device-1'),
      );
      const page = await context.newPage();
      const cdp = await context.newCDPSession(page);
      await cdp.send('Network.enable');
      await cdp.send('Network.emulateNetworkConditions', {
        offline: false,
        latency: profile.latency,
        downloadThroughput: profile.down,
        uploadThroughput: profile.up,
        connectionType: profile.latency ? 'cellular3g' : 'ethernet',
      });
      await cdp.send('Emulation.setCPUThrottlingRate', { rate: profile.cpu });
      await cdp.send('Performance.enable');
      const requests: {
        category: string;
        started: number;
        finished?: number;
        failed?: boolean;
        detail?: string;
      }[] = [];
      const pending = new Map<Request, (typeof requests)[number]>();
      let lastActivity = performance.now();
      page.on('request', (request) => {
        if (!['fetch', 'xhr'].includes(request.resourceType())) return;
        const row: (typeof requests)[number] = {
          category: requestCategory(request.url()),
          started: performance.now(),
        };
        if (row.category.startsWith('rpc:phase5_sync_pull')) {
          // Which table this page asks for = the one cursor that is not the disabled sentinel.
          try {
            const cursors = (
              request.postDataJSON() as { p_cursors?: Record<string, { updatedAt: number }> }
            ).p_cursors;
            row.detail = Object.entries(cursors ?? {})
              .filter(([, cursor]) => cursor.updatedAt !== Number.MAX_SAFE_INTEGER)
              .map(([table, cursor]) => `${table}@${cursor.updatedAt}`)
              .join(',');
          } catch {
            row.detail = 'unparsed';
          }
        }
        requests.push(row);
        pending.set(request, row);
        lastActivity = performance.now();
      });
      page.on('requestfinished', (request) => {
        const row = pending.get(request);
        if (row) {
          row.finished = performance.now();
          pending.delete(request);
          lastActivity = performance.now();
        }
      });
      page.on('requestfailed', (request) => {
        const row = pending.get(request);
        if (row) {
          row.failed = true;
          row.finished = performance.now();
          pending.delete(request);
          lastActivity = performance.now();
        }
      });
      page.on('response', (response) => {
        const row = pending.get(response.request());
        if (row && response.status() >= 400) row.failed = true;
      });
      // A request with no completion event for 60 s is not "live": run 38888120412 showed two sync pulls that
      // never reported finished/failed on the throttled profile while the app re-issued the same pages and
      // kept syncing every 30 s. Such requests stay listed in pendingRequests; they are never silently dropped.
      const STALE_REQUEST_MS = 60_000;
      const liveCount = () =>
        [...pending.values()].filter((row) => performance.now() - row.started < STALE_REQUEST_MS)
          .length;
      // Route settle must outlast the slowest known route: on the throttled profile Inventory re-downloads
      // 11 catalog pages at ~4 s each (run 38889524334). The click-to-ready time is taken before settling.
      const settle = async (timeout = 150_000) => {
        await expect
          .poll(() => liveCount() === 0 && performance.now() - lastActivity >= 200, {
            timeout,
            intervals: [50, 100],
          })
          .toBe(true);
      };
      const measured: {
        route: string;
        visit: string;
        ms: number;
        requestCounts: Record<string, number>;
        failedRequests: number;
      }[] = [];
      const report: Record<string, unknown> = {
        schemaVersion: 1,
        profile,
        viewport: { width: 390, height: 844 },
        samples,
        sourceSha: process.env.GITHUB_SHA ?? 'local-uncommitted',
        dataset: { items: 10000, invoices: 100000, suppliers: 8, customers: 8, purchaseBills: 0 },
        limitations: [
          'Synthetic desktop Chromium CPU/network profile, not a physical Android result.',
          'First visit follows completed catalog sync; not a fresh-device 2.5-second claim.',
          'Request counts include background XHR/fetch activity through a bounded settle window.',
          'Request interception disables Chromium HTTP cache; route revisits retain app/IndexedDB state only.',
          'Requests with no completion event for 60 s are excluded from the quiet check and listed under pendingRequests.',
          'Seven revisit samples; empirical nearest-rank p95 is the maximum, not a population estimate.',
        ],
        measurements: measured,
      };
      try {
        const startup = performance.now();
        await page.goto('/login');
        await page.getByLabel('Email').fill(process.env.PHASE6_PERF_EMAIL!);
        await page.getByLabel('Password', { exact: true }).fill(process.env.PHASE6_PERF_PASSWORD!);
        await page.getByRole('button', { name: 'Log in', exact: true }).click();
        await expect(page.getByText('Overview', { exact: true })).toBeVisible({ timeout: 60_000 });
        report.loginToOverviewMs = performance.now() - startup;
        // Leave boot/auth/sync out of route timings; it is reported separately, never called cached startup.
        await menu(page, '/pos');
        await page.locator('a[href="/pos"]:visible').first().click();
        await ready(page, '/pos');
        // Initial sync still transfers invoice history after the POS catalog becomes usable.
        // Keep this separately reported startup wait out of all route measurements.
        await settle(180_000);
        report.loginToCatalogReadyMs = performance.now() - startup;
        await cdp.send('Network.clearBrowserCache');
        const reload = performance.now();
        await page.reload();
        await ready(page, '/pos');
        report.httpColdReloadWithCachedCatalogMs = performance.now() - reload;
        await settle(180_000);
        report.memoryAfterBootstrap = await cdp.send('Memory.getDOMCounters');
        for (let round = 0; round <= samples; round++) {
          for (const path of routes) {
            await menu(page, path);
            await settle();
            const startIndex = requests.length;
            const start = performance.now();
            await page.locator(`a[href="${path}"]:visible`).first().click();
            await ready(page, path);
            const ms = performance.now() - start;
            await settle();
            const rows = requests.slice(startIndex);
            const counts: Record<string, number> = {};
            for (const row of rows) counts[row.category] = (counts[row.category] ?? 0) + 1;
            measured.push({
              route: path,
              visit:
                round === 0
                  ? path === '/pos'
                    ? 'post-reload-first'
                    : 'first-after-sync'
                  : 'revisit',
              ms,
              requestCounts: counts,
              failedRequests: rows.filter((row) => row.failed).length,
            });
          }
        }
        report.summary = Object.fromEntries(
          routes.map((path) => [
            path,
            summarize(
              measured
                .filter((row) => row.route === path && row.visit === 'revisit')
                .map((row) => row.ms),
            ),
          ]),
        );
        report.memory = await cdp
          .send('Performance.getMetrics')
          .then((value) =>
            value.metrics.filter((m) =>
              ['JSHeapUsedSize', 'JSHeapTotalSize', 'Nodes', 'Documents'].includes(m.name),
            ),
          );
        report.dom = await cdp.send('Memory.getDOMCounters');
        report.storage = await page.evaluate(() => navigator.storage.estimate());
        expect(blocked).toEqual([]);
        expect(measured.every((row) => row.failedRequests === 0)).toBe(true);
        report.status = 'complete';
      } catch (error) {
        report.status = 'failed';
        throw error;
      } finally {
        report.blockedExternalRequests = blocked.length;
        report.pendingRequests = [...pending.values()].map((row) => ({
          category: row.category,
          detail: row.detail,
          elapsedMs: performance.now() - row.started,
        }));
        if (report.status === 'failed') {
          // Self-describing failure: what was still pending and what the last requests were.
          const now = performance.now();
          console.log(
            `SP0 ${profile.name} diagnostics ${JSON.stringify({
              totalRequests: requests.length,
              msSinceLastActivity: Math.round(now - lastActivity),
              pending: report.pendingRequests,
              pullTimeline: requests
                .filter((row) => row.category.startsWith('rpc:phase5_sync_pull'))
                .map(
                  (row) =>
                    `${row.detail}|ago=${Math.round(now - row.started)}|ms=${row.finished ? Math.round(row.finished - row.started) : 'PENDING'}${row.failed ? '|FAILED' : ''}`,
                ),
              lastRequests: requests.slice(-12).map((row) => ({
                category: row.category,
                agoMs: Math.round(now - row.started),
                durationMs: row.finished ? Math.round(row.finished - row.started) : null,
                failed: row.failed ?? false,
              })),
            })}`,
          );
        }
        const output = process.env.SP0_RESULTS_DIR ?? testInfo.outputPath('sp0');
        await mkdir(output, { recursive: true });
        await writeFile(
          join(output, `${profile.name}.json`),
          JSON.stringify(report, null, 2) + '\n',
        );
        await testInfo.attach('sp0-navigation-baseline', {
          body: Buffer.from(JSON.stringify(report)),
          contentType: 'application/json',
        });
        console.log(
          `SP0 ${profile.name} status=${report.status} summary=${JSON.stringify(report.summary ?? {})}`,
        );
        await context.close();
      }
    });
});
