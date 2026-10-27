import { Icon } from './Icon';
import { appRoute } from '../lib/paths';

// Home quick entry, most-used first. New sale is the filled primary action for every role (old DSB's main button);
// the other entries are outlined and hidden from cashiers.
export function QuickEntry({ role }: { role: string }) {
  const staff = role !== 'cashier';
  return (
    <nav class="quick-entry" aria-label="Quick entry">
      <a class="quick-primary" href={appRoute.pos}>
        <Icon name="bill" />
        <span>New sale</span>
      </a>
      {staff && (
        <>
          <a href={appRoute.purchases + '?new=1'}>
            <Icon name="purchase" />
            <span>Purchase</span>
          </a>
          <a href={appRoute.suppliers}>
            <Icon name="money" />
            <span>Pay supplier</span>
          </a>
          <a href={appRoute.inventory}>
            <Icon name="stock" />
            <span>Stock</span>
          </a>
        </>
      )}
    </nav>
  );
}
