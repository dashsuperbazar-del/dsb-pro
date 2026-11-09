// Big daily screens loaded right after start-up as ONE chunk (frees the initial bundle; first paint is faster).
// App prefetches this chunk on idle and the service worker precaches it, so the screens still open offline.
export { InventoryScreen } from './screens/InventoryScreen';
export { SuppliersScreen } from './screens/SuppliersScreen';
