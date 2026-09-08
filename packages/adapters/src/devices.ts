import { getSupabaseClient } from './client';
import { signOut } from './auth';

export type Device = {
  id: string;
  userId: string;
  deviceId: string;
  label: string | null;
  lastSeen: string;
  appVersion: string | null;
  revokedAt: string | null;
};

const DEVICE_ID_KEY = 'dsb-pro-device-id';

// Stable per-browser identifier for register_device()'s (tenant_id, user_id,
// device_id) unique key — one row per browser, not per login.
export function getOrCreateDeviceId(): string {
  const existing = localStorage.getItem(DEVICE_ID_KEY);
  if (existing) return existing;
  const id = crypto.randomUUID();
  localStorage.setItem(DEVICE_ID_KEY, id);
  return id;
}

// Best-effort browser/OS guess so a device is never left unlabeled after
// registration (spec §5: "auto-name, editable later"). Deliberately simple —
// this is a display convenience, not a security-relevant fingerprint.
export function guessDeviceLabel(userAgent: string): string {
  const browser = /edg\//i.test(userAgent)
    ? 'Edge'
    : /chrome\//i.test(userAgent)
      ? 'Chrome'
      : /firefox\//i.test(userAgent)
        ? 'Firefox'
        : /safari\//i.test(userAgent)
          ? 'Safari'
          : null;
  const os = /android/i.test(userAgent)
    ? 'Android'
    : /iphone|ipad/i.test(userAgent)
      ? 'iOS'
      : /windows/i.test(userAgent)
        ? 'Windows'
        : /mac os/i.test(userAgent)
          ? 'macOS'
          : /linux/i.test(userAgent)
            ? 'Linux'
            : null;
  if (browser && os) return `${browser} on ${os}`;
  if (browser) return browser;
  return 'Unknown device';
}

export async function registerCurrentDevice(): Promise<string> {
  const deviceId = getOrCreateDeviceId();
  const appVersion = import.meta.env.VITE_APP_VERSION ?? 'dev';
  const { data, error } = await getSupabaseClient().rpc('register_device', {
    p_device_id: deviceId,
    p_app_version: appVersion,
  });
  if (error) throw error;
  const id = data as string;

  const { error: labelError } = await getSupabaseClient().rpc('set_device_label', {
    p_id: id,
    p_label: guessDeviceLabel(navigator.userAgent),
  });
  if (labelError) throw labelError;

  return id;
}

// RLS (devices_select_own, 0006_tenancy_rls.sql) lets any tenant member read
// every device row in their tenant — filter.onlyUserId is a UI-level choice
// (spec §5: cashier/accountant see only their own), not an RLS boundary.
export async function listDevices(filter: { onlyUserId?: string }): Promise<Device[]> {
  let query = getSupabaseClient()
    .from('devices')
    .select('id, user_id, device_id, label, last_seen, app_version, revoked_at');
  if (filter.onlyUserId) {
    query = query.eq('user_id', filter.onlyUserId);
  }
  const { data, error } = await query;
  if (error) throw error;
  return (
    data as {
      id: string;
      user_id: string;
      device_id: string;
      label: string | null;
      last_seen: string;
      app_version: string | null;
      revoked_at: string | null;
    }[]
  ).map((r) => ({
    id: r.id,
    userId: r.user_id,
    deviceId: r.device_id,
    label: r.label,
    lastSeen: r.last_seen,
    appVersion: r.app_version,
    revokedAt: r.revoked_at,
  }));
}

export async function renameDevice(id: string, label: string): Promise<void> {
  const { error } = await getSupabaseClient().rpc('set_device_label', { p_id: id, p_label: label });
  if (error) throw error;
}

// Revoking someone ELSE's device has zero enforcement today (docs/HANDOVER.md:
// "nothing yet checks it against incoming requests") — revoke_device() only
// marks the row. Revoking your OWN other device additionally calls
// signOut('others'), which Supabase Auth actually enforces immediately
// (invalidates every session for this account except the current one) — the
// closest real protection available without new backend work (Phase 5 is
// where per-device enforcement lands for real).
export async function revokeDevice(id: string, opts: { isSelf: boolean }): Promise<void> {
  const { error } = await getSupabaseClient().rpc('revoke_device', { p_id: id });
  if (error) throw error;
  if (opts.isSelf) {
    await signOut('others');
  }
}
