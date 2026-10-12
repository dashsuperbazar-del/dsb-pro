import type { Role } from '@dsb-pro/core';
import { appRoute } from '../lib/paths';

// Phone-width navigation for the daily-entry screens. Hidden on wide screens by CSS.
export function BottomNav({ role, currentPath }: { role: Role; currentPath: string }) {
  const links: [string, string][] = [
    [appRoute.pos, 'POS'],
    [appRoute.customers, 'Customers'],
    ...(role === 'cashier'
      ? []
      : ([
          [appRoute.suppliers, 'Suppliers'],
          [appRoute.expenses, 'Expenses'],
        ] as [string, string][])),
    [appRoute.home, 'Home'],
  ];
  return (
    <nav class="bottom-nav" aria-label="Quick navigation">
      {links.map(([href, label]) => (
        <a key={href} href={href} aria-current={currentPath === href ? 'page' : undefined}>
          <svg
            class="nav-mark"
            aria-hidden="true"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="1.8"
            stroke-linecap="round"
            stroke-linejoin="round"
          >
            <path
              d={
                label === 'POS'
                  ? 'M5 3h14v18l-3-2-4 2-4-2-3 2V3 M8 8h8 M8 12h5'
                  : label === 'Home'
                    ? 'M3 10l9-7 9 7 M5 9v12h14V9 M9 21v-7h6v7'
                    : label === 'Expenses'
                      ? 'M4 6h16v14H4V6 M4 6V4h12 M16 11h4v5h-4z'
                      : label === 'Customers'
                        ? 'M8 8a4 4 0 1 0 8 0a4 4 0 1 0-8 0 M4 21v-2a6 6 0 0 1 6-6h4a6 6 0 0 1 6 6v2'
                        : 'M3 8l2-5h14l2 5 M3 8v4h18V8 M5 12v9h14v-9 M9 21v-6h6v6'
              }
            />
          </svg>
          {label}
        </a>
      ))}
    </nav>
  );
}
