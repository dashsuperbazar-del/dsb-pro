import { useEffect, useState } from 'preact/hooks';
import { Router, Route } from 'preact-router';
import { signOut } from '@dsb-pro/adapters';
import { useSession } from './lib/useSession';
import { HealthPanel } from './HealthPanel';
import { LoginScreen } from './screens/LoginScreen';
import { SignupScreen } from './screens/SignupScreen';
import { NoTenantScreen } from './screens/NoTenantScreen';
import { JoinInviteScreen } from './screens/JoinInviteScreen';
import { TeamScreen } from './screens/TeamScreen';
import { DevicesScreen } from './screens/DevicesScreen';
import { PurchasesScreen } from './screens/PurchasesScreen';
import { InventoryScreen } from './screens/InventoryScreen';
import { PosScreen } from './screens/PosScreen';
import { CustomersScreen } from './screens/CustomersScreen';
import { SalesHistoryScreen } from './screens/SalesHistoryScreen';
import { SyncScreen } from './screens/SyncScreen';
import { ReportsScreen } from './screens/ReportsScreen';
import { ReturnsScreen } from './screens/ReturnsScreen';
import { SettingsScreen } from './screens/SettingsScreen';
import { SuppliersScreen } from './screens/SuppliersScreen';
import { ExpensesScreen } from './screens/ExpensesScreen';
import { StockAdjustScreen } from './screens/StockAdjustScreen';
import { CompareScreen } from './screens/CompareScreen';
import { OpeningsScreen } from './screens/OpeningsScreen';
import { SearchScreen } from './screens/SearchScreen';
import { DayBookTile } from './components/DayBookTile';
import { BottomNav } from './components/BottomNav';
import { t } from './lib/i18n';
import { VerificationBanner } from './components/VerificationBanner';
import { MoreScreen } from './screens/MoreScreen';
import { Icon } from './components/Icon';
import { applyTheme, readTheme } from './components/ThemeToggle';
import { SyncRuntime } from './components/SyncRuntime';
import { appRoute } from './lib/paths';

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
          <span class="brand-mark">DSB</span>
          <span>
            DSB Pro<small>Your shop workspace</small>
          </span>
        </a>
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
          <HealthPanel canAdjustStock={['owner', 'manager'].includes(session.membership.role)} />
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
        <Route path={appRoute.compare} component={CompareScreen} />
        <Route path={appRoute.openings} component={OpeningsScreen} />
        <Route path={appRoute.search} component={SearchScreen} />
        <Route default component={() => <Home session={session} />} />
      </Router>
      {session.status === 'active' && (
        <BottomNav role={session.membership.role} currentPath={currentPath} />
      )}
    </>
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
        <h2 class="section-label">Quick entry</h2>
        <nav class="quick-entry" aria-label="Quick entry">
          {session.membership.role !== 'cashier' && (
            <>
              <a href={appRoute.purchases + '?new=1'}>
                <Icon name="purchase" />
                <span>Purchase</span>
              </a>
              <a href={appRoute.suppliers}>
                <Icon name="money" />
                <span>Pay supplier</span>
              </a>
            </>
          )}
          <a href={appRoute.pos}>
            <Icon name="bill" />
            <span>New sale</span>
          </a>
          {session.membership.role !== 'cashier' && (
            <a href={appRoute.inventory}>
              <Icon name="stock" />
              <span>Stock</span>
            </a>
          )}
        </nav>
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
            {['owner', 'manager'].includes(session.membership.role) && (
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
