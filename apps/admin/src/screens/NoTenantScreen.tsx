import { useState } from 'preact/hooks';
import { createTenant, acceptInvite, classifyError, errorMessage } from '@dsb-pro/adapters';

export function NoTenantScreen() {
  return (
    <main>
      <h1>Welcome</h1>
      <CreateShopCard />
      <JoinCodeCard />
    </main>
  );
}

function CreateShopCard() {
  const [shopName, setShopName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: Event) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await createTenant(shopName);
      // useSession's next getCurrentMembership() poll (triggered by its own
      // auth-state listener firing again is NOT automatic here since no new
      // sign-in event occurs — see Task 7's follow-up note below) picks this
      // up. Simplest fix: reload, which re-runs useSession's initial resolve.
      window.location.reload();
    } catch (err) {
      setError(errorMessage(classifyError(err), err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section aria-label="Create your shop">
      <h2>Create your shop</h2>
      <form onSubmit={onSubmit}>
        <label>
          Shop name
          <input
            value={shopName}
            onInput={(e) => setShopName((e.target as HTMLInputElement).value)}
            required
          />
        </label>
        {error && <p role="alert">{error}</p>}
        <button type="submit" disabled={busy}>
          Create your shop
        </button>
      </form>
    </section>
  );
}

function JoinCodeCard() {
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: Event) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await acceptInvite(code.trim());
      window.location.reload();
    } catch (err) {
      setError(errorMessage(classifyError(err), err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section aria-label="Have an invite code?">
      <h2>Have an invite code?</h2>
      <form onSubmit={onSubmit}>
        <label>
          Invite code
          <input
            value={code}
            onInput={(e) => setCode((e.target as HTMLInputElement).value)}
            required
          />
        </label>
        {error && <p role="alert">{error}</p>}
        <button type="submit" disabled={busy}>
          Join
        </button>
      </form>
    </section>
  );
}
