import type { Role } from '@dsb-pro/core';
import { appRoute } from '../lib/paths';
import { Icon, type IconName } from './Icon';
export function BottomNav({
  role,
  currentPath,
  moreBadge = 0,
}: {
  role: Role;
  currentPath: string;
  /** Open online orders (shown on More, where Online orders lives). */
  moreBadge?: number;
}) {
  const links: { href: string; label: string; icon: IconName; active: boolean }[] = [
    { href: appRoute.home, label: 'Home', icon: 'home', active: currentPath === appRoute.home },
    ...(role === 'cashier'
      ? []
      : [
          {
            href: appRoute.purchases,
            label: 'Purchases',
            icon: 'purchase' as const,
            active: currentPath === appRoute.purchases,
          },
        ]),
    {
      href: appRoute.pos,
      label: 'Sales',
      icon: 'bill',
      active: [appRoute.pos, appRoute.salesHistory, appRoute.returns].includes(currentPath),
    },
    {
      href: role === 'cashier' ? appRoute.customers : appRoute.suppliers,
      label: 'Ledger',
      icon: 'people',
      active: [appRoute.suppliers, appRoute.customers].includes(currentPath),
    },
    {
      href: appRoute.more,
      label: 'More',
      icon: 'more',
      active: ![
        appRoute.home,
        appRoute.purchases,
        appRoute.pos,
        appRoute.salesHistory,
        appRoute.returns,
        appRoute.suppliers,
        appRoute.customers,
      ].includes(currentPath),
    },
  ];
  return (
    <nav class="bottom-nav" aria-label="Quick navigation">
      {links.map((link) => (
        <a key={link.href} href={link.href} aria-current={link.active ? 'page' : undefined}>
          <Icon name={link.icon} />
          <span>{link.label}</span>
          {link.href === appRoute.more && moreBadge > 0 && (
            <span class="nav-badge" aria-label={`${moreBadge} open online orders`}>
              {moreBadge > 99 ? '99+' : moreBadge}
            </span>
          )}
        </a>
      ))}
    </nav>
  );
}
