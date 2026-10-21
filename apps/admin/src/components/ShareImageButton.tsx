import { useState } from 'preact/hooks';
import { shareReceiptImage, type ReceiptDoc } from '../lib/shareImage';

// One button for every "share as image" place. The document is built when clicked (display only).
export function ShareImageButton({
  build,
  disabled,
  label = 'Share as image',
}: {
  build: () => ReceiptDoc | Promise<ReceiptDoc>;
  disabled?: boolean;
  label?: string;
}) {
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');
  const [error, setError] = useState('');
  async function run() {
    setBusy(true);
    setNote('');
    setError('');
    try {
      const outcome = await shareReceiptImage(await build());
      if (outcome === 'downloaded')
        setNote('Image downloaded. WhatsApp opened with a summary — attach the image there.');
    } catch (e) {
      setError(`The image could not be shared: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  }
  return (
    <span class="share-image no-print">
      <button type="button" disabled={disabled || busy} onClick={() => void run()}>
        {busy ? 'Preparing image…' : label}
      </button>
      {note && (
        <span role="status" class="muted">
          {' '}
          {note}
        </span>
      )}
      {error && (
        <span role="alert" class="alert">
          {' '}
          {error}
        </span>
      )}
    </span>
  );
}
