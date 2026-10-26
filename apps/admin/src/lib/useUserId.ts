import { useEffect, useState } from 'preact/hooks';
import { shopContext } from './shopContext';

/** The signed-in user's id once known (used to remember a row's open/closed choice per user). */
export function useUserId(): string | undefined {
  const [id, setId] = useState<string | undefined>();
  useEffect(() => {
    let live = true;
    void shopContext
      .get()
      .then((c) => live && setId(c.session.user.id))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, []);
  return id;
}
