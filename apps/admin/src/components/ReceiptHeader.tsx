import type { ComponentChildren } from 'preact';
import type { ProfileLoad } from '../lib/shopProfile';

// D2a: one receipt header for every printed sale. Without a loaded shop profile the receipt says so
// instead of printing a made-up shop name.
export function ReceiptHeader(props: { load: ProfileLoad | null; children?: ComponentChildren }) {
  const p = props.load?.profile;
  return (
    <header>
      {p ? (
        <>
          <h1>{p.name}</h1>
          {p.address && <p class="receipt-address">{p.address}</p>}
          {p.gstin && <p>GSTIN {p.gstin}</p>}
        </>
      ) : (
        <p role="alert">
          <strong>Shop details could not be loaded — this receipt is incomplete.</strong>
        </p>
      )}
      {props.children}
    </header>
  );
}
