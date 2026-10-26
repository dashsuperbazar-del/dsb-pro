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
    if (failed)
      return (
        <main class="page">
          <p class="alert" role="alert">
            This screen could not be loaded. Check the connection and try again.
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
        </main>
      );
    return (
      <main class="page" aria-busy="true">
        <p class="muted">Loading…</p>
      </main>
    );
  };
}
