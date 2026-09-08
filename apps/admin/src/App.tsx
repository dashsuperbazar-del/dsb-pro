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
import { VerificationBanner } from './components/VerificationBanner';
import { appRoute } from './lib/paths';

export function App() {
  const session = useSession();
  return <Router>
    <Route path={appRoute.signup} component={SignupScreen} />
    <Route path={appRoute.join} component={JoinInviteScreen} />
    <Route path={appRoute.team} component={TeamScreen} />
    <Route path={appRoute.devices} component={DevicesScreen} />
    <Route path={appRoute.inventory} component={InventoryScreen} />
    <Route default component={() => <Home session={session} />} />
  </Router>;
}

function Home({ session }: { session: ReturnType<typeof useSession> }) {
  if (session.status === 'loading') return <p>Loading…</p>;
  if (session.status === 'error') return <main><p role="alert">Unable to load your session: {session.message}</p><p>Please refresh and try again.</p></main>;
  if (session.status === 'signed-out') return <LoginScreen />;
  if (session.status === 'no-tenant') return <><VerificationBanner session={session.session} /><NoTenantScreen /></>;
  return <>
    <VerificationBanner session={session.session} />
    <main>
      <h1>DSB Pro — Admin</h1>
      <p>Signed in as tenant {session.membership.tenantId}, role {session.membership.role}.</p>
      <p><a href={appRoute.inventory}>Inventory & purchases</a> · <a href={appRoute.team}>Team</a> · <a href={appRoute.devices}>Devices</a> · <button onClick={() => void signOut()}>Sign out</button></p>
      <HealthPanel />
    </main>
  </>;
}
