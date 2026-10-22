import { useEffect, useRef, useState } from 'preact/hooks';

// The bill code of a purchase bill or sale invoice, tap to copy. Shows nothing for a document without one
// (an older cached row, or a database not yet upgraded). The code is plain text rendered by the framework.
export function BillCodeChip({ code }: { code: string | null | undefined }) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  if (!code) return null;
  async function copy() {
    try {
      await navigator.clipboard.writeText(code as string);
      setState('copied');
    } catch {
      setState('failed');
    }
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setState('idle'), 2000);
  }
  return (
    <p class="bill-code" data-testid="bill-code">
      Bill code{' '}
      <button
        type="button"
        class="bill-code-copy"
        aria-label={`Copy bill code ${code}`}
        onClick={() => void copy()}
      >
        <strong>{code}</strong>
      </button>{' '}
      <small class="muted" role="status">
        {state === 'copied'
          ? 'Copied'
          : state === 'failed'
            ? 'Could not copy: select the code'
            : 'Tap to copy'}
      </small>
    </p>
  );
}
