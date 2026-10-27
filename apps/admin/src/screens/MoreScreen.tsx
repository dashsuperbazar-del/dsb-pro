import type { Role } from '@dsb-pro/core';
import { appRoute } from '../lib/paths';
import { LanguageToggle } from '../components/LanguageToggle';
import { ThemeToggle } from '../components/ThemeToggle';
import { Icon, type IconName } from '../components/Icon';
export function MoreScreen({
  role,
  stockAdjustReady = true,
}: {
  role: Role | null;
  stockAdjustReady?: boolean;
}) {
  if (!role)
    return (
      <main>
        <h1>Shop tools</h1>
        <a href={appRoute.home}>Log in to continue</a>
      </main>
    );
  type Link = [string, string, IconName];
  const manage = role !== 'cashier';
  // D3: the same links, in the order a shopkeeper reaches for them, under short headings.
  const allGroups: { title: string; links: Link[] }[] = [
    {
      title: 'Find',
      links: [[appRoute.search, 'Search', 'report']],
    },
    {
      title: 'Daily work',
      links: [
        ...(manage
          ? ([
              [appRoute.inventory, 'Stock & items', 'stock'],
              [appRoute.expenses, 'Expenses', 'expense'],
            ] as Link[])
          : []),
        [appRoute.salesHistory, 'Sales history', 'bill'],
        [appRoute.returns, 'Returns', 'bill'],
        ...((role === 'owner' || role === 'manager') && stockAdjustReady
          ? ([[appRoute.stockAdjust, 'Stock adjust', 'stock']] as Link[])
          : []),
      ],
    },
    {
      title: 'Reports & records',
      links: [
        ...(manage ? ([[appRoute.reports, 'Reports & recovery', 'report']] as Link[]) : []),
        ...(role === 'owner' ? ([[appRoute.openings, 'Opening balances', 'money']] as Link[]) : []),
        ...(role === 'owner' || role === 'manager'
          ? ([[appRoute.auditLog, 'Audit log', 'report']] as Link[])
          : []),
      ],
    },
    {
      title: 'Shop & devices',
      links: [
        ...(role === 'owner' ? ([[appRoute.team, 'Team', 'people']] as Link[]) : []),
        [appRoute.sync, 'Sync & offline', 'sync'],
        [appRoute.devices, 'Devices', 'settings'],
        [appRoute.settings, 'Settings', 'settings'],
      ],
    },
  ];
  const groups = allGroups.filter((g) => g.links.length > 0);
  return (
    <main class="more-page">
      <h1>Shop tools</h1>
      <nav class="more-groups" aria-label="Shop tools">
        {groups.map((g) => (
          <section key={g.title} class="more-group" aria-label={g.title}>
            <h2>{g.title}</h2>
            <div class="workspace-list">
              {g.links.map(([href, label, icon]) => (
                <a key={href} href={href}>
                  <Icon name={icon} />
                  <span>{label}</span>
                  <Icon name="arrow" />
                </a>
              ))}
            </div>
          </section>
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
