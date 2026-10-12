export type IconName =
  | 'home'
  | 'bill'
  | 'people'
  | 'stock'
  | 'more'
  | 'purchase'
  | 'money'
  | 'expense'
  | 'report'
  | 'sync'
  | 'settings'
  | 'arrow';
const paths: Record<IconName, string> = {
  home: 'M3 10l9-7 9 7M5 9v12h14V9M9 21v-7h6v7',
  bill: 'M5 3h14v18l-3-2-4 2-4-2-3 2V3M8 8h8M8 12h5',
  people: 'M8 8a4 4 0 1 0 8 0a4 4 0 1 0-8 0M4 21v-2a6 6 0 0 1 6-6h4a6 6 0 0 1 6 6v2',
  stock: 'M3 7l9-4 9 4v10l-9 4-9-4V7M3 7l9 4 9-4M12 11v10',
  more: 'M4 6h16M4 12h16M4 18h16',
  purchase: 'M3 3h2l2 12h11l3-9H6M9 19h.01M17 19h.01',
  money: 'M3 5h18v14H3zM9 12a3 3 0 1 0 6 0a3 3 0 1 0-6 0M6 9h.01M18 15h.01',
  expense: 'M4 6h16v14H4V6M4 6V4h12M16 11h4v5h-4z',
  report: 'M4 20V10M10 20V4M16 20v-7M22 20H2',
  sync: 'M20 7a9 9 0 0 0-15-2L2 8M2 3v5h5M4 17a9 9 0 0 0 15 2l3-3M22 21v-5h-5',
  settings: 'M4 6h16M4 12h16M4 18h16M8 3v6M16 9v6M10 15v6',
  arrow: 'M9 5l7 7-7 7',
};
export function Icon({ name }: { name: IconName }) {
  return (
    <svg
      class="app-icon"
      aria-hidden="true"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="1.8"
      stroke-linecap="round"
      stroke-linejoin="round"
    >
      <path d={paths[name]} />
    </svg>
  );
}
