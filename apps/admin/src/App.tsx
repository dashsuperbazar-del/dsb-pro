import { Router, Route } from 'preact-router';
import { useSession } from './lib/useSession';
import { HealthPanel } from './HealthPanel';

export function App() {
  const session = useSession();

  return (
    <Router>
      <Route path="/*" component={() => <Home session={session} />} />
    </Router>
  );
}

// Screens land in Tasks 8-12: LoginScreen/SignupScreen (signed-out),
// NoTenantScreen (no-tenant), the real app shell (active). This placeholder
// keeps Phase 0's HealthPanel reachable so the plan's earlier tasks stay
// green before those screens exist.
function Home({ session }: { session: ReturnType<typeof useSession> }) {
  if (session.status === 'loading') {
    return <p>Loading…</p>;
  }
  if (session.status === 'signed-out') {
    return <p>Signed out. Login/Signup screens land in Task 8.</p>;
  }
  if (session.status === 'no-tenant') {
    return <p>Signed in, no tenant yet. NoTenantScreen lands in Task 9.</p>;
  }
  return (
    <main>
      <h1>DSB Pro — Admin</h1>
      <p>Signed in as tenant {session.membership.tenantId}, role {session.membership.role}.</p>
      <HealthPanel />
    </main>
  );
}
