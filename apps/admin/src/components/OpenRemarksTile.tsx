import { useEffect, useState } from 'preact/hooks';
import { addRemarkOutcome, listOpenRemarks, type OpenRemark } from '@dsb-pro/adapters';
import { shopContext } from '../lib/shopContext';
import { flushRemarkQueue, remarkAgeDays, remarkDocHref } from '../lib/remarkQueue';

type State = { state: 'loading' } | { state: 'error' } | { state: 'ok'; value: OpenRemark[] };

const SHOWN = 8;

// Home: open pending remarks of this shop, oldest first. Each opens its bill or invoice (a corrected bill
// opens itself). A read failure is shown as unavailable, never as "nothing pending".
export function OpenRemarksTile() {
  const [s, setS] = useState<State>({ state: 'loading' });
  const [all, setAll] = useState(false);
  useEffect(() => {
    let alive = true;
    void (async () => {
      const { session, shopId } = await shopContext.get();
      // Remarks written offline go first, with their own ids (never twice).
      await flushRemarkQueue(session.user.id, (e) =>
        addRemarkOutcome({
          shopId: e.shopId,
          docKind: e.docKind,
          docId: e.docId,
          body: e.body,
          clientId: e.clientId,
        }),
      ).catch(() => undefined);
      const value = await listOpenRemarks(shopId);
      if (alive) setS({ state: 'ok', value });
    })().catch(() => {
      if (alive) setS({ state: 'error' });
    });
    return () => {
      alive = false;
    };
  }, []);
  const list = s.state === 'ok' ? (all ? s.value : s.value.slice(0, SHOWN)) : [];
  return (
    <section class="card open-remarks-tile" aria-label="Pending items">
      <h2>Pending items</h2>
      {s.state === 'loading' && <p class="muted">Checking pending remarks…</p>}
      {s.state === 'error' && <p role="alert">Pending remarks are unavailable right now.</p>}
      {s.state === 'ok' && !s.value.length && (
        <p class="muted">No pending items on bills or invoices.</p>
      )}
      {list.length > 0 && (
        <ul class="remark-list">
          {list.map((r) => {
            const age = remarkAgeDays(r.createdAt);
            return (
              <li key={r.id} data-testid="open-remark">
                <a href={remarkDocHref(r)}>
                  <strong>
                    {r.docKind === 'purchase' ? 'Bill' : 'Invoice'} {r.docNo ?? ''}
                    {r.partyName ? ` · ${r.partyName}` : ''}
                  </strong>
                </a>{' '}
                {r.body}
                <small class="muted">
                  {' '}
                  · {age === 0 ? 'today' : `${age} day${age === 1 ? '' : 's'}`}
                  {r.docStatus === 'VOID' ? ' · document voided' : ''}
                </small>
              </li>
            );
          })}
        </ul>
      )}
      {s.state === 'ok' && s.value.length > SHOWN && (
        <button type="button" class="link" onClick={() => setAll(!all)}>
          {all ? 'Show fewer' : `Show all ${s.value.length}`}
        </button>
      )}
    </section>
  );
}
