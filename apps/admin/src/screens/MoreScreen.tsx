import type { Role } from '@dsb-pro/core';
import { appRoute } from '../lib/paths';
import { LanguageToggle } from '../components/LanguageToggle';
import { ThemeToggle } from '../components/ThemeToggle';
import { Icon, type IconName } from '../components/Icon';
export function MoreScreen({ role }: { role: Role | null }) {
  if (!role)
    return (
      <main>
        <h1>Shop tools</h1>
        <a href={appRoute.home}>Log in to continue</a>
      </main>
    );
  const links: [string, string, IconName][] = [
    [appRoute.search, 'Search', 'report'],
    ...(role === 'cashier'
      ? []
      : ([
          [appRoute.inventory, 'Stock & items', 'stock'],
          [appRoute.expenses, 'Expenses', 'expense'],
          [appRoute.reports, 'Reports & recovery', 'report'],
        ] as [string, string, IconName][])),
    [appRoute.salesHistory, 'Sales history', 'bill'],
    [appRoute.returns, 'Returns', 'bill'],
    [appRoute.sync, 'Sync & offline', 'sync'],
    ...(role === 'owner' || role === 'manager'
      ? ([[appRoute.stockAdjust, 'Stock adjust', 'stock']] as [string, string, IconName][])
      : []),
    ...(role === 'owner'
      ? ([
          [appRoute.openings, 'Opening balances', 'money'],
          [appRoute.team, 'Team', 'people'],
          [appRoute.auditLog, 'Audit log', 'report'],
        ] as [string, string, IconName][])
      : []),
    [appRoute.devices, 'Devices', 'settings'],
    [appRoute.settings, 'Settings', 'settings'],
  ];
  return (
    <main class="more-page">
      <h1>Shop tools</h1>
      <nav class="workspace-list" aria-label="Shop tools">
        {links.map(([href, label, icon]) => (
          <a key={href} href={href}>
            <Icon name={icon} />
            <span>{label}</span>
            <Icon name="arrow" />
          </a>
        ))}
      </nav>
      <section class="card">
        <h2>Preferences</h2>
        <div class="grid-form">
          <LanguageToggle />
          <ThemeToggle />
        </div>
      </section>
      {role === 'owner' && (
        <details class="card">
          <summary>Advanced & legacy tools</summary>
          <a href={appRoute.inventory + '?view=advanced'}>Import old DSB backup</a>
        </details>
      )}
    </main>
  );
}
