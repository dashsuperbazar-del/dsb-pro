import { useEffect, useRef, useState } from 'preact/hooks';
import { speechRecognitionCtor } from '../lib/voiceEntry';
import { Icon } from './Icon';

// One-shot speech-to-text button. Hidden where the browser has no speech recognition.
export function VoiceEntryButton({
  onText,
  disabled,
  name,
  compact,
}: {
  /** An icon button (bill item rows); the accessible name is `name` (or "Speak"). */
  compact?: boolean;
  onText: (text: string) => void;
  disabled?: boolean;
  /** Accessible name when several Speak buttons share a screen, e.g. "Speak item 2". */
  name?: string;
}) {
  const [listening, setListening] = useState(false);
  const [error, setError] = useState('');
  const rec = useRef<{ stop: () => void } | null>(null);
  useEffect(() => () => rec.current?.stop(), []);
  const Ctor = speechRecognitionCtor();
  if (!Ctor) return null;
  function toggle() {
    if (rec.current) {
      rec.current.stop();
      return;
    }
    setError('');
    const r = new Ctor!();
    r.lang = 'en-IN';
    r.continuous = false;
    r.interimResults = false;
    r.onresult = (e) => {
      const text = e.results[0]?.[0]?.transcript ?? '';
      if (text) onText(text);
    };
    r.onerror = (e) =>
      setError(
        e.error === 'not-allowed'
          ? 'Microphone permission was denied. Type it instead.'
          : 'Could not hear that. Try again or type it.',
      );
    r.onend = () => {
      rec.current = null;
      setListening(false);
    };
    rec.current = r;
    setListening(true);
    r.start();
  }
  return (
    <span>
      <button
        type="button"
        disabled={disabled}
        aria-pressed={listening}
        aria-label={listening ? undefined : (name ?? (compact ? 'Speak' : undefined))}
        title={compact && !listening ? (name ?? 'Speak') : undefined}
        class={compact ? 'icon-button' : undefined}
        onClick={toggle}
      >
        {listening ? 'Stop listening' : compact ? <Icon name="mic" /> : 'Speak'}
      </button>
      {listening && (
        <span class="muted" role="status">
          {' '}
          Say: item name, quantity, unit, rate
        </span>
      )}
      {error && (
        <span class="alert" role="alert">
          {' '}
          {error}
        </span>
      )}
    </span>
  );
}
