import { useEffect, useState } from 'preact/hooks';
import {
  listDevices,
  renameDevice,
  revokeDevice,
  getOrCreateDeviceId,
  classifyError,
  errorMessage,
  type Device,
} from '@dsb-pro/adapters';
import { hasPerm } from '@dsb-pro/core';
import { useSession } from '../lib/useSession';

export function DevicesScreen() {
  const session = useSession();

  if (session.status !== 'active') {
    return <p>Sign in to view devices.</p>;
  }

  const canManageOthers = hasPerm(session.membership.role, 'MANAGE_DEVICES');

  return (
    <main>
      <h1>Devices</h1>
      <MyDevices userId={session.session.user.id} />
      {canManageOthers && <AllDevices selfUserId={session.session.user.id} />}
    </main>
  );
}

function DeviceRow({
  device,
  isSelf,
  isCurrentBrowser,
  onRenamed,
  onRevoked,
}: {
  device: Device;
  isSelf: boolean;
  isCurrentBrowser: boolean;
  onRenamed: (id: string, label: string) => void;
  onRevoked: (id: string) => void;
}) {
  const [renaming, setRenaming] = useState(false);
  const [newLabel, setNewLabel] = useState(device.label ?? '');
  const [error, setError] = useState<string | null>(null);

  async function save() {
    try {
      await renameDevice(device.id, newLabel);
      onRenamed(device.id, newLabel);
      setRenaming(false);
    } catch (err) {
      setError(errorMessage(classifyError(err), err));
    }
  }

  async function revoke() {
    try {
      await revokeDevice(device.id, { isSelf });
      onRevoked(device.id);
    } catch (err) {
      setError(errorMessage(classifyError(err), err));
    }
  }

  return (
    <li>
      {device.label ?? 'Unlabeled device'}
      {isCurrentBrowser && ' (this device)'} — last seen {new Date(device.lastSeen).toLocaleString()}
      {renaming ? (
        <>
          <label>
            New name
            <input value={newLabel} onInput={(e) => setNewLabel((e.target as HTMLInputElement).value)} />
          </label>
          <button onClick={save}>Save</button>
        </>
      ) : (
        <button onClick={() => setRenaming(true)}>Rename</button>
      )}
      {device.revokedAt ? (
        <span> (revoked)</span>
      ) : (
        <button onClick={revoke}>Revoke</button>
      )}
      {error && <p role="alert">{error}</p>}
    </li>
  );
}

function MyDevices({ userId }: { userId: string }) {
  const [devices, setDevices] = useState<Device[] | null>(null);
  const currentDeviceId = getOrCreateDeviceId();

  useEffect(() => {
    listDevices({ onlyUserId: userId }).then(setDevices);
  }, [userId]);

  function onRenamed(id: string, label: string) {
    setDevices((prev) => (prev ? prev.map((d) => (d.id === id ? { ...d, label } : d)) : prev));
  }
  function onRevoked(id: string) {
    setDevices((prev) => (prev ? prev.map((d) => (d.id === id ? { ...d, revokedAt: new Date().toISOString() } : d)) : prev));
  }

  return (
    <section aria-label="My devices" data-testid="my-devices">
      <h2>My devices</h2>
      <p>Revoking one of your own other devices also signs you out everywhere else.</p>
      <ul>
        {devices?.map((d) => (
          <DeviceRow
            key={d.id}
            device={d}
            isSelf
            isCurrentBrowser={d.deviceId === currentDeviceId}
            onRenamed={onRenamed}
            onRevoked={onRevoked}
          />
        ))}
      </ul>
    </section>
  );
}

function AllDevices({ selfUserId }: { selfUserId: string }) {
  const [devices, setDevices] = useState<Device[] | null>(null);

  useEffect(() => {
    listDevices({}).then((all) => setDevices(all.filter((d) => d.userId !== selfUserId)));
  }, [selfUserId]);

  function onRenamed(id: string, label: string) {
    setDevices((prev) => (prev ? prev.map((d) => (d.id === id ? { ...d, label } : d)) : prev));
  }
  function onRevoked(id: string) {
    setDevices((prev) => (prev ? prev.map((d) => (d.id === id ? { ...d, revokedAt: new Date().toISOString() } : d)) : prev));
  }

  return (
    <section aria-label="All devices">
      <h2>All devices</h2>
      <p>
        Revoking someone else's device removes it from this list. It does not yet block that device from
        continuing to use the app — that protection is planned for a later update.
      </p>
      <ul>
        {devices?.map((d) => (
          <DeviceRow
            key={d.id}
            device={d}
            isSelf={false}
            isCurrentBrowser={false}
            onRenamed={onRenamed}
            onRevoked={onRevoked}
          />
        ))}
      </ul>
    </section>
  );
}
