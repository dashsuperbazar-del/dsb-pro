import { useState } from 'preact/hooks';
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
import { DayBookTile } from './components/DayBookTile';
import { BottomNav } from './components/BottomNav';
import { t } from './lib/i18n';
import { VerificationBanner } from './components/VerificationBanner';
import { LanguageToggle } from './components/LanguageToggle';
import { SyncRuntime } from './components/SyncRuntime';
import { appRoute } from './lib/paths';

export function App() {
  const session = useSession();
  const [currentPath, setCurrentPath] = useState(window.location.pathname);
  const testMode = import.meta.env.VITE_TEST_MODE === 'phase4-shop-test';
  return (
    <>
      <SyncRuntime session={session} />
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
        <Route path={appRoute.signup} component={SignupScreen} />
        <Route path={appRoute.join} component={JoinInviteScreen} />
        <Route path={appRoute.team} component={TeamScreen} />
        <Route path={appRoute.devices} component={DevicesScreen} />
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
          <div>
            <p class="eyebrow">YOUR SHOP WORKSPACE</p>
            <h1>DSB Pro — Admin</h1>
          </div>
          <LanguageToggle />
        </div>
        {session.offline && (
          <p class="alert" role="status">
            Backend unavailable — using the last verified local shop snapshot. Sales can be queued
            safely for sync.
          </p>
        )}
        {session.membership.role !== 'cashier' && <DayBookTile />}
        <nav class="action-grid" aria-label="Shop actions">
          <a class="action-tile action-featured" href={appRoute.pos}>
            <strong>Sales POS</strong>
            <span>Start a bill · scan or find products</span>
            <b aria-hidden="true">→</b>
          </a>
          <a class="action-tile" href={appRoute.inventory}>
            <strong>Inventory & purchases</strong>
            <span>Items, prices and purchase bills</span>
          </a>
          <a class="action-tile" href={appRoute.customers}>
            <strong>Customers & ledger</strong>
            <span>Balances and received payments</span>
          </a>
          {session.membership.role !== 'cashier' && (
            <>
              <a class="action-tile" href={appRoute.suppliers}>
                <strong>{t('suppliers')}</strong>
                <span>Purchase balances and payments</span>
              </a>
              <a class="action-tile" href={appRoute.expenses}>
                <strong>Expenses</strong>
                <span>Record daily shop spending</span>
              </a>
            </>
          )}
          <a class="action-tile" href={appRoute.salesHistory}>
            <strong>Sales history</strong>
            <span>Find invoices and print receipts</span>
          </a>
          <a class="action-tile" href={appRoute.returns}>
            <strong>Returns</strong>
            <span>Return items against a bill</span>
          </a>
          <a class="action-tile" href={appRoute.reports}>
            <strong>Reports & recovery</strong>
            <span>Day book, exports and backups</span>
          </a>
          <a class="action-tile" href={appRoute.sync}>
            <strong>Sync & offline</strong>
            <span>Check pending entries</span>
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
