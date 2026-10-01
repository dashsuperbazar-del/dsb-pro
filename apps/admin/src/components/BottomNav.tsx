import type { Role } from '@dsb-pro/core';
import { appRoute } from '../lib/paths';

// Phone-width navigation for the daily-entry screens. Hidden on wide screens by CSS.
export function BottomNav({ role }: { role: Role }) {
  const links: [string, string][] = [
    [appRoute.pos, 'POS'],
    [appRoute.customers, 'Customers'],
    ...(role === 'cashier'
      ? []
      : ([
          [appRoute.suppliers, 'Suppliers'],
          [appRoute.expenses, 'Expenses'],
        ] as [string, string][])),
    [appRoute.home, 'More'],
  ];
  return (
    <nav class="bottom-nav" aria-label="Quick navigation">
      {links.map(([href, label]) => (
        <a key={href} href={href}>
          {label}
        </a>
      ))}
    </nav>
  );
}
