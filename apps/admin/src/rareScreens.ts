// Rarely used screens, loaded on demand as ONE chunk (D2): one chunk compresses better than many, and
// the service worker precaches it (dist/precache.json) so these screens still open offline.
export { TeamScreen } from './screens/TeamScreen';
export { DevicesScreen } from './screens/DevicesScreen';
export { CustomersScreen } from './screens/CustomersScreen';
export { SalesHistoryScreen } from './screens/SalesHistoryScreen';
export { SyncScreen } from './screens/SyncScreen';
export { ReportsScreen } from './screens/ReportsScreen';
export { ReturnsScreen } from './screens/ReturnsScreen';
export { SettingsScreen } from './screens/SettingsScreen';
export { ExpensesScreen } from './screens/ExpensesScreen';
export { StockAdjustScreen } from './screens/StockAdjustScreen';
export { OpeningsScreen } from './screens/OpeningsScreen';
export { SearchScreen } from './screens/SearchScreen';
export { AuditLogScreen } from './screens/AuditLogScreen';
