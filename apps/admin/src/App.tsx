import { Router, Route } from 'preact-router';
import { useSession } from './lib/useSession';
import { HealthPanel } from './HealthPanel';
import { LoginScreen } from './screens/LoginScreen';
import { SignupScreen } from './screens/SignupScreen';
import { NoTenantScreen } from './screens/NoTenantScreen';
import { JoinInviteScreen } from './screens/JoinInviteScreen';

export function App() {
  const session = useSession();

  return (
    <Router>
      <Route path="/signup" component={SignupScreen} />
      <Route path="/join/:token?" component={JoinInviteScreen} />
      <Route default component={() => <Home session={session} />} />
    </Router>
  );
}

function Home({ session }: { session: ReturnType<typeof useSession> }) {
  if (session.status === 'loading') {
    return <p>Loading…</p>;
  }
  if (session.status === 'signed-out') {
    return <LoginScreen />;
  }
  if (session.status === 'no-tenant') {
    return <NoTenantScreen />;
  }
  return (
    <main>
      <h1>DSB Pro — Admin</h1>
      <p>Signed in as tenant {session.membership.tenantId}, role {session.membership.role}.</p>
      <HealthPanel />
    </main>
  );
}
