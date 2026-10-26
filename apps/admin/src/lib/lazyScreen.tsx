import type { ComponentType } from 'preact';
import { useEffect, useState } from 'preact/hooks';

// Code-splits a rarely used screen out of the first-load chunk (D2). The chunk is in the service
// worker's precache (dist/precache.json), so the screen still opens offline once the app installed.
// A failed load (e.g. first visit, offline, before the worker cached it) shows a retry, never a blank.
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- route screens take varied props
type Screen = ComponentType<any>;
export function lazyScreen(load: () => Promise<Screen>): Screen {
  let loaded: Screen | null = null;
  let pending: Promise<Screen> | null = null;
  const get = () =>
    (pending ??= load().then(
      (c) => (loaded = c),
      (e: unknown) => {
        pending = null;
        throw e;
      },
    ));
  return function LazyScreen(props: Record<string, unknown>) {
    const [Screen, setScreen] = useState<Screen | null>(() => loaded);
    const [failed, setFailed] = useState(false);
    const [attempt, setAttempt] = useState(0);
    useEffect(() => {
      if (Screen) return;
      let live = true;
      get().then(
        (c) => live && setScreen(() => c),
        () => live && setFailed(true),
      );
      return () => {
        live = false;
      };
    }, [attempt]);
    if (Screen) return <Screen {...props} />;
    if (failed) {
      // Online (or already retried once) the chunk is gone from this page's build: only a reload
      // fetches the current app. Drafts and the outbox live in localStorage / IndexedDB, so a
      // reload keeps them; nothing is held only in memory because no screen is mounted yet.
      const needsReload = navigator.onLine || attempt >= 1;
      return (
        <main class="page">
          {needsReload ? (
            <>
              <p class="alert" role="alert">
                This screen needs the latest version of the app. Reload to get it. Anything saved on
                this device stays saved.
              </p>
              <button type="button" class="primary" onClick={() => location.reload()}>
                Reload the app
              </button>
            </>
          ) : (
            <>
              <p class="alert" role="alert">
                This screen is not saved on this device yet. Reconnect, then try again.
              </p>
              <button
                type="button"
                onClick={() => {
                  setFailed(false);
                  setAttempt((n) => n + 1);
                }}
              >
                Try again
              </button>
            </>
          )}
        </main>
      );
    }
    return (
      <main class="page" aria-busy="true">
        <p class="muted">Loading…</p>
      </main>
    );
  };
}
