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
import { VerificationBanner } from './components/VerificationBanner';
import { LanguageToggle } from './components/LanguageToggle';
import { SyncRuntime } from './components/SyncRuntime';
import { appRoute } from './lib/paths';

export function App() {
  const session = useSession();
  const testMode = import.meta.env.VITE_TEST_MODE === 'phase4-shop-test';
  return <>
    <SyncRuntime session={session}/>
    {testMode && <div class="shop-test-banner" role="status"><strong>PHASE 4 SHOP TEST</strong> — Use legacy DSB as the official record today. Enter the same transactions here only for comparison.</div>}
    <Router>
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
      <Route default component={() => <Home session={session} />} />
    </Router>
  </>;
}

function Home({ session }: { session: ReturnType<typeof useSession> }) {
  if (session.status === 'loading') return <p>Loading…</p>;
  if (session.status === 'error') return <main><p role="alert">Unable to load your session: {session.message}</p><p>Please refresh and try again.</p></main>;
  if (session.status === 'signed-out') return <LoginScreen />;
  if (session.status === 'no-tenant') return <><VerificationBanner session={session.session} /><NoTenantScreen /></>;
  return <>
    <VerificationBanner session={session.session} />
    <main>
      <div class="row"><h1>DSB Pro — Admin</h1><LanguageToggle /></div>
      {session.offline&&<p class="alert" role="status">Backend unavailable — using the last verified local shop snapshot. Sales can be queued safely for sync.</p>}
      <p>Signed in as tenant {session.membership.tenantId}, role {session.membership.role}.</p>
      <p><a href={appRoute.pos}>Sales POS</a> · <a href={appRoute.salesHistory}>Sales history</a> · <a href={appRoute.customers}>Customers & ledger</a> · <a href={appRoute.inventory}>Inventory & purchases</a> · <a href={appRoute.reports}>Reports & recovery</a> · <a href={appRoute.sync}>Sync & offline</a> · <a href={appRoute.team}>Team</a> · <a href={appRoute.devices}>Devices</a> · <button onClick={() => void signOut()}>Sign out</button></p>
      <HealthPanel />
    </main>
  </>;
}
