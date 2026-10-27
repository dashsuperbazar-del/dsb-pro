import { errorText } from '../lib/friendlyError';
import { useState } from 'preact/hooks';
import { shareReceiptImage, whatsappLink, type ReceiptDoc } from '../lib/shareImage';

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
  const [link, setLink] = useState('');
  async function run() {
    setBusy(true);
    setNote('');
    setError('');
    setLink('');
    try {
      const doc = await build();
      const outcome = await shareReceiptImage(doc);
      if (outcome === 'downloaded')
        setNote('Image downloaded. WhatsApp opened with a summary — attach the image there.');
      if (outcome === 'downloaded-no-popup') {
        setNote('Image downloaded. Open WhatsApp to send it:');
        setLink(whatsappLink(doc.phone, doc.summary));
      }
    } catch (e) {
      setError(`The image could not be shared: ${errorText(e)}`);
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
          {link && (
            <>
              {' '}
              <a href={link} target="_blank" rel="noopener noreferrer">
                Open WhatsApp
              </a>
            </>
          )}
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
