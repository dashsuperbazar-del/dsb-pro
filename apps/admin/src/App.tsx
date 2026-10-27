import { useEffect, useState } from 'preact/hooks';
import { Router, Route } from 'preact-router';
import { signOut } from '@dsb-pro/adapters';
import { useSession } from './lib/useSession';
import { HealthPanel } from './HealthPanel';
import { LoginScreen } from './screens/LoginScreen';
import { SignupScreen } from './screens/SignupScreen';
import { NoTenantScreen } from './screens/NoTenantScreen';
import { JoinInviteScreen } from './screens/JoinInviteScreen';
import { PurchasesScreen } from './screens/PurchasesScreen';
import { InventoryScreen } from './screens/InventoryScreen';
import { PosScreen } from './screens/PosScreen';
import { SuppliersScreen } from './screens/SuppliersScreen';
import { DayBookTile } from './components/DayBookTile';
import { AttentionTile } from './components/AttentionTile';
import { OpenRemarksTile } from './components/OpenRemarksTile';
import { QuickEntry } from './components/QuickEntry';
import { BottomNav } from './components/BottomNav';
import { t } from './lib/i18n';
import { VerificationBanner } from './components/VerificationBanner';
import { MoreScreen } from './screens/MoreScreen';
import { Icon } from './components/Icon';
import { applyTheme, readTheme } from './components/ThemeToggle';
import { SyncRuntime } from './components/SyncRuntime';
import { SyncIndicator } from './components/SyncIndicator';
import { Awning } from './components/Logo';
import { loadShopProfile, readCachedShopName } from './lib/shopProfile';
import { appRoute } from './lib/paths';
import { lazyScreen } from './lib/lazyScreen';

// Rarely used screens load on demand (D2 bundle room); the service worker precaches their chunks.
const TeamScreen = lazyScreen(() => import('./rareScreens').then((m) => m.TeamScreen));
const DevicesScreen = lazyScreen(() => import('./rareScreens').then((m) => m.DevicesScreen));
const CustomersScreen = lazyScreen(() => import('./rareScreens').then((m) => m.CustomersScreen));
const SalesHistoryScreen = lazyScreen(() =>
  import('./rareScreens').then((m) => m.SalesHistoryScreen),
);
const SyncScreen = lazyScreen(() => import('./rareScreens').then((m) => m.SyncScreen));
const ReportsScreen = lazyScreen(() => import('./rareScreens').then((m) => m.ReportsScreen));
const ReturnsScreen = lazyScreen(() => import('./rareScreens').then((m) => m.ReturnsScreen));
const SettingsScreen = lazyScreen(() => import('./rareScreens').then((m) => m.SettingsScreen));
const ExpensesScreen = lazyScreen(() => import('./rareScreens').then((m) => m.ExpensesScreen));
const StockAdjustScreen = lazyScreen(() =>
  import('./rareScreens').then((m) => m.StockAdjustScreen),
);
const OpeningsScreen = lazyScreen(() => import('./rareScreens').then((m) => m.OpeningsScreen));
const SearchScreen = lazyScreen(() => import('./rareScreens').then((m) => m.SearchScreen));
const AuditLogScreen = lazyScreen(() => import('./rareScreens').then((m) => m.AuditLogScreen));

// POS and purchase entry keep the money first: the health pill stays on Home/Settings (D4).
const onPath = (path: string, route: string) => path === route || path.startsWith(route + '/');
export const isCounterEntryPath = (path: string) =>
  onPath(path, appRoute.pos) || onPath(path, appRoute.purchases);

export function App() {
  const session = useSession();
  useEffect(() => {
    applyTheme(readTheme());
  }, []);
  const [currentPath, setCurrentPath] = useState(window.location.pathname);
  const testMode = import.meta.env.VITE_TEST_MODE === 'phase4-shop-test';
  return (
    <>
      <SyncRuntime session={session} />
      <header class="app-bar no-print">
        <a href={appRoute.home} class="app-brand" aria-label="DSB Pro home">
          <span class="brand-lockup">
            <Awning />
            <span class="brand-word">
              DSB <span class="brand-pro">Pro</span>
            </span>
            <ShopName session={session} />
          </span>
        </a>
        {session.status === 'active' && <SyncIndicator />}
        {session.status === 'active' && (
          <a href={appRoute.more} class="toolbar-action" aria-label="Shop tools">
            <Icon name="settings" />
          </a>
        )}
      </header>
      {testMode && (
        <div class="shop-test-banner" role="status">
          <strong>PHASE 4 SHOP TEST</strong> — Use legacy DSB as the official record today. Enter
          the same transactions here only for comparison.
        </div>
      )}
      {session.status === 'active' && session.membership.role !== 'cashier' && (
        <div class="health-container no-print">
          <HealthPanel
            canAdjustStock={
              ['owner', 'manager'].includes(session.membership.role) &&
              (session.verified || session.offline)
            }
            quiet={isCounterEntryPath(currentPath)}
          />
        </div>
      )}
      <Router onChange={(event) => setCurrentPath(event.url.split(/[?#]/)[0])}>
        <Route
          path={appRoute.more}
          component={() => (
            <MoreScreen role={session.status === 'active' ? session.membership.role : null} />
          )}
        />
        <Route path={appRoute.signup} component={SignupScreen} />
        <Route path={appRoute.join} component={JoinInviteScreen} />
        <Route path={appRoute.team} component={TeamScreen} />
        <Route path={appRoute.devices} component={DevicesScreen} />
        <Route path={appRoute.purchases} component={PurchasesScreen} />
        <Route path={appRoute.inventory} component={InventoryScreen} />
        <Route path={appRoute.pos} component={PosScreen} />
        <Route path={appRoute.customers} component={CustomersScreen} />
        <Route path={appRoute.salesHistory} component={SalesHistoryScreen} />
        <Route path={appRoute.sync} component={SyncScreen} />
        <Route path={appRoute.reports} component={ReportsScreen} />
        <Route path={appRoute.returns} component={ReturnsScreen} />
        <Route path={appRoute.settings} component={SettingsScreen} />
        <Route path={appRoute.suppliers} component={SuppliersScreen} />
        <Route path={appRoute.expenses} component={ExpensesScreen} />
        <Route path={appRoute.stockAdjust} component={StockAdjustScreen} />
        <Route path={appRoute.openings} component={OpeningsScreen} />
        <Route path={appRoute.search} component={SearchScreen} />
        <Route path={appRoute.auditLog} component={AuditLogScreen} />
        <Route default component={() => <Home session={session} />} />
      </Router>
      {session.status === 'active' && (
        <BottomNav role={session.membership.role} currentPath={currentPath} />
      )}
    </>
  );
}

// The header's shop name comes from the receipt-profile cache; when nothing usable is cached yet (new
// device, or only a placeholder), read it once so the line shows the real name instead of staying empty.
// It owns its refresh state: updating the name must NOT re-render App (that would remount Home and
// re-fetch every tile just after the first screen).
function ShopName({ session }: { session: ReturnType<typeof useSession> }) {
  const [, refreshName] = useState(0);
  const activeUser = session.status === 'active' ? session.session.user.id : '';
  const firstShop = session.status === 'active' ? session.membership.shopIds[0] : undefined;
  useEffect(() => {
    if (!activeUser || !firstShop) return;
    if (readCachedShopName(activeUser, [firstShop])) return;
    void loadShopProfile(firstShop)
      .then(() => refreshName((n) => n + 1))
      .catch(() => undefined);
  }, [activeUser, firstShop]);
  return (
    <small>
      {(session.status === 'active' &&
        readCachedShopName(session.session.user.id, session.membership.shopIds)) ||
        'Your shop workspace'}
    </small>
  );
}

function Home({ session }: { session: ReturnType<typeof useSession> }) {
  if (session.status === 'loading') return <p>Loading…</p>;
  if (session.status === 'error')
    return (
      <main>
        <p role="alert">Unable to load your session: {session.message}</p>
        <p>Please refresh and try again.</p>
      </main>
    );
  if (session.status === 'signed-out') return <LoginScreen />;
  if (session.status === 'no-tenant')
    return (
      <>
        <VerificationBanner session={session.session} />
        <NoTenantScreen />
      </>
    );
  return (
    <>
      <VerificationBanner session={session.session} />
      <main class="dashboard">
        <div class="dashboard-heading">
          <h1>Overview</h1>
          <a class="quiet-link" href={appRoute.search}>
            Search
          </a>
          <a class="quiet-link" href={appRoute.sync}>
            Sync status
          </a>
        </div>
        {session.offline && (
          <p class="alert" role="status">
            Backend unavailable — using the last verified local shop snapshot. Sales can be queued
            safely for sync.
          </p>
        )}
        {session.membership.role !== 'cashier' && <DayBookTile />}
        {session.membership.role !== 'cashier' && (
          <AttentionTile userId={session.session.user.id} />
        )}
        <OpenRemarksTile userId={session.session.user.id} />
        <h2 class="section-label">Quick entry</h2>
        <QuickEntry role={session.membership.role} />
        <h2 class="section-label">Workspace</h2>
        <nav class="workspace-list" aria-label="Shop actions">
          <a href={appRoute.pos}>
            <Icon name="bill" />
            <strong>Sales POS</strong>
            <Icon name="arrow" />
          </a>
          {session.membership.role !== 'cashier' && (
            <a href={appRoute.purchases}>
              <Icon name="purchase" />
              <strong>Purchase bills</strong>
              <Icon name="arrow" />
            </a>
          )}
          <a href={appRoute.customers}>
            <Icon name="people" />
            <strong>Customers & ledger</strong>
            <Icon name="arrow" />
          </a>
          {session.membership.role !== 'cashier' && (
            <>
              <a href={appRoute.suppliers}>
                <Icon name="people" />
                <strong>{t('suppliers')}</strong>
                <Icon name="arrow" />
              </a>
              <a href={appRoute.expenses} aria-label="Expenses">
                <Icon name="expense" />
                <strong>Expenses</strong>
                <Icon name="arrow" />
              </a>
              <a href={appRoute.reports}>
                <Icon name="report" />
                <strong>Reports & recovery</strong>
                <Icon name="arrow" />
              </a>
            </>
          )}
          <a href={appRoute.salesHistory}>
            <Icon name="bill" />
            <strong>Sales history</strong>
            <Icon name="arrow" />
          </a>
          <a href={appRoute.returns}>
            <Icon name="bill" />
            <strong>Returns</strong>
            <Icon name="arrow" />
          </a>
          <a href={appRoute.sync}>
            <Icon name="sync" />
            <strong>Sync & offline</strong>
            <Icon name="arrow" />
          </a>
        </nav>
        <details class="card shop-tools">
          <summary>Shop management</summary>
          <nav class="management-links" aria-label="Shop management">
            {['owner', 'manager'].includes(session.membership.role) &&
              (session.verified || session.offline) && (
                <a href={appRoute.stockAdjust}>Stock adjust</a>
              )}
            <a href={appRoute.team}>Team</a>
            <a href={appRoute.devices}>Devices</a>
            <a href={appRoute.settings}>Settings</a>
          </nav>
        </details>
        <div class="account-row">
          <span class="muted">Signed in · {session.membership.role}</span>
          <button onClick={() => void signOut()}>Sign out</button>
        </div>
      </main>
    </>
  );
}
