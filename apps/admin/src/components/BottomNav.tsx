import type { Role } from '@dsb-pro/core';
import { appRoute } from '../lib/paths';
import { Icon, type IconName } from './Icon';
export function BottomNav({ role, currentPath }: { role: Role; currentPath: string }) {
  const links: { href: string; label: string; icon: IconName; active: boolean }[] = [
    { href: appRoute.home, label: 'Home', icon: 'home', active: currentPath === appRoute.home },
    {
      href: appRoute.pos,
      label: 'Billing',
      icon: 'bill',
      active: [appRoute.pos, appRoute.salesHistory, appRoute.returns].includes(currentPath),
    },
    {
      href: role === 'cashier' ? appRoute.customers : appRoute.suppliers,
      label: 'Parties',
      icon: 'people',
      active: [appRoute.suppliers, appRoute.customers].includes(currentPath),
    },
    ...(role === 'cashier'
      ? []
      : [
          {
            href: appRoute.inventory,
            label: 'Stock',
            icon: 'stock' as const,
            active: [appRoute.inventory, appRoute.stockAdjust].includes(currentPath),
          },
        ]),
    {
      href: appRoute.more,
      label: 'More',
      icon: 'more',
      active: ![
        appRoute.home,
        appRoute.pos,
        appRoute.salesHistory,
        appRoute.returns,
        appRoute.suppliers,
        appRoute.customers,
        appRoute.inventory,
        appRoute.stockAdjust,
      ].includes(currentPath),
    },
  ];
  return (
    <nav class="bottom-nav" aria-label="Quick navigation">
      {links.map((link) => (
        <a key={link.href} href={link.href} aria-current={link.active ? 'page' : undefined}>
          <Icon name={link.icon} />
          <span>{link.label}</span>
        </a>
      ))}
    </nav>
  );
}
