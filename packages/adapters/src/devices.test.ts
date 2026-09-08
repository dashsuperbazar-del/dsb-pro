import { describe, expect, it, vi, beforeEach } from 'vitest';
import { __setSupabaseClientForTest } from './client';
import * as authModule from './auth';
import {
  getOrCreateDeviceId,
  guessDeviceLabel,
  registerCurrentDevice,
  listDevices,
  renameDevice,
  revokeDevice,
} from './devices';

function makeMockClient(rpcResults: Record<string, unknown> = {}, deviceRows: unknown[] = []) {
  return {
    rpc: vi.fn((fn: string) => Promise.resolve({ data: rpcResults[fn] ?? null, error: null })),
    from: vi.fn(() => ({
      select: () => ({
        eq: () => Promise.resolve({ data: deviceRows, error: null }),
        then: (resolve: (r: unknown) => void) => resolve({ data: deviceRows, error: null }),
      }),
    })),
  };
}

describe('getOrCreateDeviceId', () => {
  beforeEach(() => localStorage.clear());

  it('creates a uuid on first call and persists it', () => {
    const id = getOrCreateDeviceId();
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(getOrCreateDeviceId()).toBe(id);
  });
});

describe('guessDeviceLabel', () => {
  it('recognizes Chrome on Android', () => {
    expect(guessDeviceLabel('Mozilla/5.0 (Linux; Android 14) Chrome/128 Mobile Safari')).toBe('Chrome on Android');
  });

  it('falls back to a generic label for an unrecognized UA', () => {
    expect(guessDeviceLabel('SomeWeirdBot/1.0')).toBe('Unknown device');
  });
});

describe('registerCurrentDevice', () => {
  it('calls register_device then set_device_label with a guessed label', async () => {
    localStorage.clear();
    const client = makeMockClient({ register_device: 'device-row-1', set_device_label: null });
    __setSupabaseClientForTest(client as never);
    const id = await registerCurrentDevice();
    expect(id).toBe('device-row-1');
    expect(client.rpc).toHaveBeenCalledWith(
      'register_device',
      expect.objectContaining({ p_device_id: expect.any(String), p_app_version: expect.any(String) }),
    );
    expect(client.rpc).toHaveBeenCalledWith('set_device_label', { p_id: 'device-row-1', p_label: expect.any(String) });
  });
});

describe('listDevices', () => {
  it('maps rows to camelCase', async () => {
    const client = makeMockClient({}, [
      { id: 'd1', user_id: 'u1', device_id: 'dev-1', label: 'My Phone', last_seen: 'ls', app_version: '1.0', revoked_at: null },
    ]);
    __setSupabaseClientForTest(client as never);
    await expect(listDevices({})).resolves.toEqual([
      { id: 'd1', userId: 'u1', deviceId: 'dev-1', label: 'My Phone', lastSeen: 'ls', appVersion: '1.0', revokedAt: null },
    ]);
  });
});

describe('renameDevice', () => {
  it('calls set_device_label', async () => {
    const client = makeMockClient({ set_device_label: null });
    __setSupabaseClientForTest(client as never);
    await renameDevice('d1', 'Counter tablet');
    expect(client.rpc).toHaveBeenCalledWith('set_device_label', { p_id: 'd1', p_label: 'Counter tablet' });
  });
});

describe('revokeDevice', () => {
  it('calls revoke_device only, when revoking someone else\'s device', async () => {
    const client = makeMockClient({ revoke_device: null });
    __setSupabaseClientForTest(client as never);
    const signOutSpy = vi.spyOn(authModule, 'signOut').mockResolvedValue();
    await revokeDevice('d1', { isSelf: false });
    expect(client.rpc).toHaveBeenCalledWith('revoke_device', { p_id: 'd1' });
    expect(signOutSpy).not.toHaveBeenCalled();
    signOutSpy.mockRestore();
  });

  it('also signs out other sessions when revoking your own other device', async () => {
    const client = makeMockClient({ revoke_device: null });
    __setSupabaseClientForTest(client as never);
    const signOutSpy = vi.spyOn(authModule, 'signOut').mockResolvedValue();
    await revokeDevice('d1', { isSelf: true });
    expect(client.rpc).toHaveBeenCalledWith('revoke_device', { p_id: 'd1' });
    expect(signOutSpy).toHaveBeenCalledWith('others');
    signOutSpy.mockRestore();
  });
});
